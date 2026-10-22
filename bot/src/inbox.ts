import { Database } from 'bun:sqlite';
import type { BotMessage } from './contracts';

export interface InboxRow {
	key: string;
	group_id: string;
	user_id: string;
	payload: string;
	reply: string | null;
	status: string;
	accepted_at: number;
}
/** Durable receive/execute/reply boundaries; ambiguous execution is never replayed. */
export class Inbox {
	private db: Database;
	constructor(path: string) {
		this.db = new Database(path, { create: true, strict: true });
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS qq_inbox (
			key TEXT PRIMARY KEY, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
			payload TEXT NOT NULL, reply TEXT, status TEXT NOT NULL, accepted_at INTEGER NOT NULL);
			CREATE INDEX IF NOT EXISTS qq_inbox_status ON qq_inbox(status, accepted_at);
			CREATE INDEX IF NOT EXISTS qq_inbox_rate ON qq_inbox(group_id, user_id, accepted_at);`);
	}
	accept(key: string, message: BotMessage, now: number): 'accepted' | 'duplicate' | 'limited' {
		return this.db
			.transaction(() => {
				if (this.db.query('SELECT key FROM qq_inbox WHERE key=?').get(key))
					return 'duplicate' as const;
				const counts = this.db
					.query<{ total: number; own: number }, [string, string, number]>(
						'SELECT count(*) AS total, coalesce(sum(user_id=?),0) AS own FROM qq_inbox WHERE group_id=? AND accepted_at>?'
					)
					.get(message.userId, message.groupId, now - 60000)!;
				if (counts.own >= 12 || counts.total >= 120) return 'limited' as const;
				this.db
					.query('INSERT INTO qq_inbox VALUES (?,?,?,?,NULL,?,?)')
					.run(key, message.groupId, message.userId, JSON.stringify(message), 'pending', now);
				return 'accepted' as const;
			})
			.immediate();
	}
	recover(): void {
		this.db
			.query("UPDATE qq_inbox SET status='done', payload='', reply=? WHERE status='processing'")
			.run(
				'机器人上次处理时中断，未自动重试。请用 /积分 查询；若涉及换边，请联系管理员核对操作记录。'
			);
		this.db.exec("UPDATE qq_inbox SET status='reply_unknown' WHERE status='replying'");
	}
	claim(): InboxRow | null {
		return this.db
			.transaction(() => {
				const row = this.db
					.query<InboxRow, []>(
						"SELECT * FROM qq_inbox WHERE status='pending' ORDER BY accepted_at, rowid LIMIT 1"
					)
					.get();
				if (row) this.db.query("UPDATE qq_inbox SET status='processing' WHERE key=?").run(row.key);
				return row;
			})
			.immediate();
	}
	finish(key: string, reply: string): void {
		this.db
			.query(
				"UPDATE qq_inbox SET status='done', payload='', reply=? WHERE key=? AND status='processing'"
			)
			.run(reply.slice(0, 4000), key);
	}
	claimReply(): InboxRow | null {
		return this.db
			.transaction(() => {
				const row = this.db
					.query<InboxRow, []>(
						"SELECT * FROM qq_inbox WHERE status='done' ORDER BY accepted_at, rowid LIMIT 1"
					)
					.get();
				if (row) this.db.query("UPDATE qq_inbox SET status='replying' WHERE key=?").run(row.key);
				return row;
			})
			.immediate();
	}
	replied(key: string, success: boolean): void {
		this.db
			.query("UPDATE qq_inbox SET status=? WHERE key=? AND status='replying'")
			.run(success ? 'sent' : 'reply_unknown', key);
	}
	stats(): Record<string, number> {
		return Object.fromEntries(
			this.db
				.query<{ status: string; n: number }, []>(
					'SELECT status,count(*) AS n FROM qq_inbox GROUP BY status'
				)
				.all()
				.map((r) => [r.status, r.n])
		);
	}
	prune(now: number): void {
		// Expired incoming events are rejected before enqueue. Retain uncertainty for operator review.
		this.db
			.query("DELETE FROM qq_inbox WHERE status='sent' AND accepted_at<?")
			.run(now - 14 * 86400000);
	}
	close(): void {
		this.db.close();
	}
}
