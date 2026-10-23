import { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BotMessage } from './contracts';
import { AdminConflictError, AdminValidationError } from './admin-store';
export interface Manager {
	qq: string;
	label: string;
	enabled: boolean;
	serverIds: string[];
}
export interface ManagerOperation {
	id: string;
	actor: string;
	qq: string;
	serverId: string;
	groupId: string;
	configRevision: string;
	policyRevision: number;
	command: string;
	args: string;
	expected: string;
	summary: string;
	state: string;
	result: string | null;
	expiresAt: number;
	createdAt: number;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function managerActor(m: BotMessage): string | null {
	if (m.officialReply) {
		const t = m.officialReply;
		const prefix =
			t.scope === 'c2c' ? `qqofficial:c2c:${t.appId}:` : `qqofficial:${t.appId}:${t.groupOpenid}:`;
		if (!m.userId.startsWith(prefix)) return null;
		const member = m.userId.slice(prefix.length);
		if (!/^[a-zA-Z0-9_-]{1,128}$/.test(member) || (t.scope === 'c2c' && member !== t.userOpenid))
			return null;
		return m.userId;
	}
	return /^[1-9][0-9]{4,15}$/.test(m.userId) ? 'napcat:' + m.userId : null;
}
export class ManagerStore {
	private db: Database;
	constructor(path: string) {
		this.db = new Database(path, { create: true, strict: true });
		this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS bot_manager_policy(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,members TEXT NOT NULL DEFAULT '[]');
 INSERT OR IGNORE INTO bot_manager_policy(id) VALUES(1);
 CREATE TABLE IF NOT EXISTS bot_manager_identities(actor TEXT PRIMARY KEY,qq TEXT NOT NULL,groupId TEXT NOT NULL,verifiedAt INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS bot_manager_challenges(hash TEXT PRIMARY KEY,actor TEXT NOT NULL,groupId TEXT NOT NULL,expiresAt INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS bot_manager_operations(id TEXT PRIMARY KEY,codeHash TEXT NOT NULL UNIQUE,actor TEXT NOT NULL,qq TEXT NOT NULL,serverId TEXT NOT NULL,groupId TEXT NOT NULL,configRevision TEXT NOT NULL,policyRevision INTEGER NOT NULL,command TEXT NOT NULL,args TEXT NOT NULL,expected TEXT NOT NULL,summary TEXT NOT NULL,state TEXT NOT NULL,result TEXT,expiresAt INTEGER NOT NULL,createdAt INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS bot_manager_audit(id INTEGER PRIMARY KEY,qq TEXT NOT NULL,serverId TEXT NOT NULL,command TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL);`);
		this.db.exec(
			"UPDATE bot_manager_operations SET state='unknown',result='进程中断，执行结果待核实；不会自动重复执行' WHERE state='running'"
		);
	}
	close() {
		this.db.close();
	}
	policy(): { revision: number; members: Manager[] } {
		const r = this.db
			.query<{ revision: number; members: string }, []>(
				'SELECT revision,members FROM bot_manager_policy WHERE id=1'
			)
			.get()!;
		return { revision: r.revision, members: JSON.parse(r.members) };
	}
	save(revision: unknown, raw: unknown) {
		if (!Number.isSafeInteger(revision) || !Array.isArray(raw) || raw.length > 100)
			throw new AdminValidationError('管理员白名单格式无效');
		const seen = new Set<string>();
		const members: Manager[] = raw.map((x) => {
			if (
				!x ||
				typeof x.qq !== 'string' ||
				!/^[1-9][0-9]{4,15}$/.test(x.qq) ||
				seen.has(x.qq) ||
				typeof x.label !== 'string' ||
				x.label.length > 80 ||
				/[\x00-\x1f\x7f]/.test(x.label) ||
				typeof x.enabled !== 'boolean' ||
				!Array.isArray(x.serverIds) ||
				!x.serverIds.length ||
				x.serverIds.length > 100 ||
				x.serverIds.some(
					(s: unknown) => typeof s !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(s)
				)
			)
				throw new AdminValidationError('QQ号需唯一，并选择至少一个授权服务器');
			seen.add(x.qq);
			return {
				qq: x.qq,
				label: x.label,
				enabled: x.enabled,
				serverIds: [...new Set<string>(x.serverIds)]
			};
		});
		this.db
			.transaction(() => {
				if (
					this.db
						.query(
							'UPDATE bot_manager_policy SET members=?,revision=revision+1 WHERE id=1 AND revision=?'
						)
						.run(JSON.stringify(members), revision as number).changes !== 1
				)
					throw new AdminConflictError();
				const valid = new Set(members.map((x) => x.qq));
				for (const x of this.identities())
					if (!valid.has(x.qq))
						this.db.query('DELETE FROM bot_manager_identities WHERE actor=?').run(x.actor);
			})
			.immediate();
		return this.policy();
	}
	identities() {
		return this.db
			.query<{ actor: string; qq: string; groupId: string; verifiedAt: number }, []>(
				'SELECT * FROM bot_manager_identities ORDER BY verifiedAt DESC'
			)
			.all();
	}
	authorize(m: BotMessage, serverId: string): Manager | null {
		const actor = managerActor(m);
		if (!actor) return null;
		const qq = actor.startsWith('napcat:')
			? actor.slice(7)
			: this.db
					.query<{ qq: string }, [string, string]>(
						'SELECT qq FROM bot_manager_identities WHERE actor=? AND groupId=?'
					)
					.get(actor, m.groupId)?.qq;
		return (
			this.policy().members.find(
				(x) => x.qq === qq && x.enabled && x.serverIds.includes(serverId)
			) ?? null
		);
	}
	challenge(m: BotMessage, now = Date.now()) {
		const actor = managerActor(m);
		if (!actor) throw new AdminValidationError('无法识别当前消息身份');
		const code = randomBytes(4).toString('hex');
		this.db
			.transaction(() => {
				this.db
					.query('DELETE FROM bot_manager_challenges WHERE expiresAt<=? OR actor=?')
					.run(now, actor);
				if (
					(this.db
						.query<{ n: number }, []>('SELECT count(*) AS n FROM bot_manager_challenges')
						.get()?.n ?? 0) >= 100
				)
					throw new AdminValidationError('身份申请过多，请稍后再试');
				this.db
					.query('INSERT INTO bot_manager_challenges VALUES(?,?,?,?)')
					.run(hash(code), actor, m.groupId, now + 600000);
			})
			.immediate();
		return code;
	}
	bind(revision: unknown, qq: unknown, code: unknown, now = Date.now()) {
		if (typeof qq !== 'string' || typeof code !== 'string' || !/^[a-f0-9]{8}$/.test(code))
			throw new AdminValidationError('请填写QQ号和8位身份码');
		this.db
			.transaction(() => {
				const p = this.policy();
				if (p.revision !== revision) throw new AdminConflictError();
				if (!p.members.some((x) => x.qq === qq && x.enabled))
					throw new AdminValidationError('该QQ号不在启用的白名单中');
				const c = this.db
					.query<{ actor: string; groupId: string; expiresAt: number }, [string]>(
						'SELECT * FROM bot_manager_challenges WHERE hash=?'
					)
					.get(hash(code));
				if (!c || c.expiresAt <= now) throw new AdminValidationError('身份码不存在或已过期');
				const owner = this.db
					.query<{ qq: string }, [string]>('SELECT qq FROM bot_manager_identities WHERE actor=?')
					.get(c.actor);
				if (owner && owner.qq !== qq)
					throw new AdminValidationError('该身份已关联其他QQ号，请先解除');
				this.db
					.query('INSERT OR REPLACE INTO bot_manager_identities VALUES(?,?,?,?)')
					.run(c.actor, qq, c.groupId, now);
				this.db.query('DELETE FROM bot_manager_challenges WHERE hash=?').run(hash(code));
				this.db.exec('UPDATE bot_manager_policy SET revision=revision+1 WHERE id=1');
			})
			.immediate();
	}
	unbind(revision: unknown, actor: unknown) {
		if (typeof actor !== 'string') throw new AdminValidationError('身份无效');
		this.db
			.transaction(() => {
				if (this.policy().revision !== revision) throw new AdminConflictError();
				this.db.query('DELETE FROM bot_manager_identities WHERE actor=?').run(actor);
				this.db.exec('UPDATE bot_manager_policy SET revision=revision+1 WHERE id=1');
			})
			.immediate();
	}
	quote(
		m: BotMessage,
		manager: Manager,
		serverId: string,
		command: string,
		args: string,
		expected: string,
		summary: string,
		now = Date.now()
	) {
		const code = randomBytes(4).toString('hex');
		const id = randomUUID();
		this.db
			.transaction(() => {
				this.db
					.query(
						"UPDATE bot_manager_operations SET state='cancelled',result='已由新请求替代' WHERE actor=? AND groupId=? AND serverId=? AND state='pending'"
					)
					.run(managerActor(m)!, m.groupId, serverId);
				this.db
					.query('INSERT INTO bot_manager_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
					.run(
						id,
						hash(code),
						managerActor(m)!,
						manager.qq,
						serverId,
						m.groupId,
						m.configurationRevision ?? '',
						this.policy().revision,
						command,
						args,
						expected,
						summary,
						'pending',
						null,
						now + 120000,
						now
					);
			})
			.immediate();
		return { id, code };
	}
	operation(m: BotMessage, serverId: string, code: string) {
		return this.db
			.query<ManagerOperation, [string, string, string, string]>(
				'SELECT * FROM bot_manager_operations WHERE codeHash=? AND actor=? AND groupId=? AND serverId=?'
			)
			.get(hash(code), managerActor(m) ?? '', m.groupId, serverId);
	}
	claim(id: string) {
		return (
			this.db
				.query("UPDATE bot_manager_operations SET state='running' WHERE id=? AND state='pending'")
				.run(id).changes === 1
		);
	}
	finish(id: string, state: string, result: string) {
		this.db
			.query('UPDATE bot_manager_operations SET state=?,result=? WHERE id=?')
			.run(state, result.slice(0, 3000), id);
	}
	audit(qq: string, serverId: string, command: string, outcome: string) {
		this.db
			.query(
				'INSERT INTO bot_manager_audit(qq,serverId,command,outcome,createdAt) VALUES(?,?,?,?,?)'
			)
			.run(qq, serverId, command, outcome, Date.now());
	}
	recent(serverId?: string) {
		return this.db
			.query<
				{
					id: string;
					qq: string;
					serverId: string;
					command: string;
					summary: string;
					state: string;
					result: string | null;
					createdAt: number;
				},
				[string | null, string | null]
			>(
				'SELECT id,qq,serverId,command,summary,state,result,createdAt FROM bot_manager_operations WHERE (? IS NULL OR serverId=?) ORDER BY createdAt DESC LIMIT 50'
			)
			.all(serverId ?? null, serverId ?? null);
	}
	uncertain(actor: string, serverId: string, command: string, args: string) {
		return this.db
			.query<{ id: string }, [string, string, string, string]>(
				"SELECT id FROM bot_manager_operations WHERE actor=? AND serverId=? AND command=? AND args=? AND state='unknown' LIMIT 1"
			)
			.get(actor, serverId, command, args);
	}
	reconcile(id: unknown, reason: unknown) {
		if (
			typeof id !== 'string' ||
			typeof reason !== 'string' ||
			!reason.trim() ||
			reason.length > 500
		)
			throw new AdminValidationError('请填写核实记录和理由');
		if (
			this.db
				.query(
					"UPDATE bot_manager_operations SET state='reviewed',result=? WHERE id=? AND state='unknown'"
				)
				.run('管理员已核实：' + reason.trim(), id).changes !== 1
		)
			throw new AdminValidationError('只能核实结果未知的操作');
	}
}
