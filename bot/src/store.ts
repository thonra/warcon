import { Database } from 'bun:sqlite';
import { officialUserId } from './config';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class BotUserError extends Error {}
export interface Binding {
	communityId: string;
	userId: string;
	steamId: string;
}
export interface MoveOperation extends Binding {
	id: string;
	serverId: string;
	faction: string;
	cost: number;
	state: 'running' | 'unknown' | 'succeeded' | 'refunded';
	createdAt: number;
	finishedAt: number | null;
	reason: string | null;
}
export interface Confirmation extends Binding {
	id: string;
	serverId: string;
	faction: string;
	cost: number;
	expiresAt: number;
	operationId: string | null;
}
type ChallengeRow = {
	steamId: string;
	salt: string;
	hash: string;
	expiresAt: number;
	attempts: number;
};
type ConfirmationRow = Confirmation & { salt: string; hash: string };
const digest = (salt: string, code: string) =>
	createHash('sha256').update(`${salt}:${code}`).digest('hex');
function matches(salt: string, hash: string, code: string) {
	return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(digest(salt, code), 'hex'));
}

/** SQLite owns the points ledger and operation state, including uncertain remote effects. */
export class BotStore {
	private readonly db: Database;
	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new Database(path, { create: true, strict: true });
		this.db.exec(
			'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;'
		);
		const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!
			.user_version;
		if (version > 1) throw new Error(`Unsupported bot database version: ${version}`);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS identity_links (
				communityId TEXT NOT NULL, identityId TEXT NOT NULL, userId TEXT NOT NULL, verifiedAt INTEGER NOT NULL,
				PRIMARY KEY (communityId, identityId)
			);
			CREATE TABLE IF NOT EXISTS bindings (
				communityId TEXT NOT NULL, userId TEXT NOT NULL, steamId TEXT NOT NULL, createdAt INTEGER NOT NULL,
				PRIMARY KEY (communityId, userId), UNIQUE (communityId, steamId)
			);
			CREATE TABLE IF NOT EXISTS accounts (
				communityId TEXT NOT NULL, userId TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
				PRIMARY KEY (communityId, userId)
			);
			CREATE TABLE IF NOT EXISTS ledger (
				id INTEGER PRIMARY KEY, communityId TEXT NOT NULL, userId TEXT NOT NULL, delta INTEGER NOT NULL,
				reason TEXT NOT NULL, correlation TEXT NOT NULL, createdAt INTEGER NOT NULL,
				UNIQUE (communityId, userId, correlation)
			);
			CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
			CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
			CREATE TABLE IF NOT EXISTS binding_challenges (
				communityId TEXT NOT NULL, userId TEXT NOT NULL, steamId TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
				createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (communityId, userId)
			);
			CREATE TABLE IF NOT EXISTS checkins (
				communityId TEXT NOT NULL, userId TEXT NOT NULL, day TEXT NOT NULL, createdAt INTEGER NOT NULL,
				PRIMARY KEY (communityId, userId, day)
			);
			CREATE TABLE IF NOT EXISTS confirmations (
				id TEXT PRIMARY KEY, communityId TEXT NOT NULL, userId TEXT NOT NULL, steamId TEXT NOT NULL,
				serverId TEXT NOT NULL, faction TEXT NOT NULL, cost INTEGER NOT NULL CHECK (cost >= 0),
				salt TEXT NOT NULL, hash TEXT NOT NULL, expiresAt INTEGER NOT NULL, operationId TEXT,
				UNIQUE (communityId, userId, serverId)
			);
			CREATE TABLE IF NOT EXISTS operations (
				id TEXT PRIMARY KEY, communityId TEXT NOT NULL, userId TEXT NOT NULL, steamId TEXT NOT NULL,
				serverId TEXT NOT NULL, faction TEXT NOT NULL, cost INTEGER NOT NULL CHECK (cost >= 0),
				state TEXT NOT NULL CHECK (state IN ('running', 'unknown', 'succeeded', 'refunded')),
				createdAt INTEGER NOT NULL, finishedAt INTEGER, reason TEXT,
				confirmationId TEXT NOT NULL UNIQUE
			);
			CREATE UNIQUE INDEX IF NOT EXISTS one_pending_move ON operations (communityId, steamId) WHERE state IN ('running', 'unknown');
			PRAGMA user_version = 1;
		`);
	}
	close() {
		this.db.close();
	}
	/** VACUUM INTO takes a consistent snapshot, including committed WAL pages. Never copy a live .db alone. */
	backup(path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db.query('VACUUM INTO ?').run(path);
	}
	/** Link channel-specific identities only after proving ownership via the game whisper. */
	accountUserId(communityId: string, identityId: string): string {
		return (
			this.db
				.query<{ userId: string }, [string, string]>(
					'SELECT userId FROM identity_links WHERE communityId=? AND identityId=?'
				)
				.get(communityId, identityId)?.userId ?? identityId
		);
	}
	binding(communityId: string, userId: string): Binding | null {
		return this.db
			.query<Binding, [string, string]>(
				'SELECT communityId, userId, steamId FROM bindings WHERE communityId = ? AND userId = ?'
			)
			.get(communityId, userId);
	}
	beginBinding(communityId: string, userId: string, steamId: string, code: string, now: number) {
		this.db
			.transaction(() => {
				if (this.binding(communityId, this.accountUserId(communityId, userId)))
					throw new BotUserError('你已经绑定了 Steam 账号\n更换绑定请联系管理员');
				if (
					!officialUserId(userId) &&
					this.db
						.query('SELECT 1 FROM bindings WHERE communityId = ? AND steamId = ?')
						.get(communityId, steamId)
				)
					throw new BotUserError('这个 Steam 账号已被绑定，请联系管理员核实');
				const previous = this.db
					.query<{ createdAt: number }, [string, string]>(
						'SELECT createdAt FROM binding_challenges WHERE communityId = ? AND userId = ?'
					)
					.get(communityId, userId);
				if (previous && now - previous.createdAt < 60_000)
					throw new BotUserError('验证码已发送，请查看游戏内私信\n每分钟最多申请一次');
				const salt = randomBytes(16).toString('hex');
				this.db
					.query(
						`INSERT INTO binding_challenges (communityId, userId, steamId, salt, hash, createdAt, expiresAt, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
				ON CONFLICT (communityId, userId) DO UPDATE SET steamId = excluded.steamId, salt = excluded.salt, hash = excluded.hash, createdAt = excluded.createdAt, expiresAt = excluded.expiresAt, attempts = 0`
					)
					.run(communityId, userId, steamId, salt, digest(salt, code), now, now + 300_000);
			})
			.immediate();
	}
	verifyBinding(communityId: string, userId: string, code: string, now: number): Binding {
		// Return errors from the transaction so failed attempts are committed, rather than rolled back.
		const result = this.db
			.transaction((): Binding | string => {
				if (this.binding(communityId, this.accountUserId(communityId, userId)))
					return '你已经完成绑定，无需重复验证';
				const challenge = this.db
					.query<ChallengeRow, [string, string]>(
						'SELECT steamId, salt, hash, expiresAt, attempts FROM binding_challenges WHERE communityId = ? AND userId = ?'
					)
					.get(communityId, userId);
				if (!challenge || challenge.expiresAt <= now)
					return '验证码不存在或已过期\n请先发送 /绑定 你的SteamID64';
				if (challenge.attempts >= 5) return '验证失败次数过多，请等待一分钟后重新 /绑定';
				if (!matches(challenge.salt, challenge.hash, code)) {
					this.db
						.query(
							'UPDATE binding_challenges SET attempts = attempts + 1 WHERE communityId = ? AND userId = ?'
						)
						.run(communityId, userId);
					return `验证码不正确，还可尝试 ${4 - challenge.attempts} 次\n请查看游戏内私信，不要使用其他人的验证码`;
				}
				const existing = this.db
					.query<Binding, [string, string]>(
						'SELECT communityId,userId,steamId FROM bindings WHERE communityId=? AND steamId=?'
					)
					.get(communityId, challenge.steamId);
				if (existing) {
					if (!officialUserId(userId)) return '这个 Steam 账号已被其他人绑定，请联系管理员核实';
					this.db
						.query(
							'INSERT INTO identity_links (communityId,identityId,userId,verifiedAt) VALUES (?,?,?,?)'
						)
						.run(communityId, userId, existing.userId, now);
					this.db
						.query('DELETE FROM binding_challenges WHERE communityId=? AND userId=?')
						.run(communityId, userId);
					return existing;
				}
				this.db
					.query(
						'INSERT INTO bindings (communityId, userId, steamId, createdAt) VALUES (?, ?, ?, ?)'
					)
					.run(communityId, userId, challenge.steamId, now);
				this.db
					.query('INSERT OR IGNORE INTO accounts (communityId, userId) VALUES (?, ?)')
					.run(communityId, userId);
				this.db
					.query('DELETE FROM binding_challenges WHERE communityId = ? AND userId = ?')
					.run(communityId, userId);
				return { communityId, userId, steamId: challenge.steamId };
			})
			.immediate();
		if (typeof result === 'string') throw new BotUserError(result);
		return result;
	}
	balance(communityId: string, userId: string) {
		return (
			this.db
				.query<{ balance: number }, [string, string]>(
					'SELECT balance FROM accounts WHERE communityId = ? AND userId = ?'
				)
				.get(communityId, userId)?.balance ?? 0
		);
	}
	private addLedger(
		communityId: string,
		userId: string,
		delta: number,
		reason: string,
		correlation: string,
		now: number
	) {
		if (!Number.isSafeInteger(delta)) throw new Error('Points must be safe integers');
		this.db
			.query(
				'INSERT INTO ledger (communityId, userId, delta, reason, correlation, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
			)
			.run(communityId, userId, delta, reason, correlation, now);
		const result = this.db
			.query(
				'UPDATE accounts SET balance = balance + ? WHERE communityId = ? AND userId = ? AND balance + ? >= 0 AND balance + ? <= 9007199254740991'
			)
			.run(delta, communityId, userId, delta, delta);
		if (result.changes !== 1) throw new BotUserError('积分不足，或积分余额已达到上限');
	}
	checkin(communityId: string, userId: string, day: string, points: number, now: number) {
		if (!Number.isSafeInteger(points) || points < 0) throw new Error('Invalid check-in points');
		return this.db
			.transaction(() => {
				if (!this.binding(communityId, userId))
					throw new BotUserError('请先 /绑定 你的SteamID64，并在游戏内完成验证码验证');
				const inserted = this.db
					.query(
						'INSERT OR IGNORE INTO checkins (communityId, userId, day, createdAt) VALUES (?, ?, ?, ?)'
					)
					.run(communityId, userId, day, now);
				if (inserted.changes)
					this.addLedger(communityId, userId, points, '每日签到', `checkin:${day}`, now);
				return { added: inserted.changes > 0, balance: this.balance(communityId, userId) };
			})
			.immediate();
	}
	pending(communityId: string, steamId: string): MoveOperation | null {
		return this.db
			.query<MoveOperation, [string, string]>(
				"SELECT * FROM operations WHERE communityId = ? AND steamId = ? AND state IN ('running', 'unknown')"
			)
			.get(communityId, steamId);
	}
	assertCanMove(communityId: string, steamId: string, cooldownSeconds: number, now: number) {
		const pending = this.pending(communityId, steamId);
		if (pending)
			throw new BotUserError(
				pending.state === 'unknown'
					? `上一笔换边结果待管理员核实，已暂时锁定后续换边\n订单：${pending.id}\n积分暂扣，不会重复执行`
					: '上一笔换边正在处理，请稍候'
			);
		const last = this.db
			.query<{ finishedAt: number }, [string, string]>(
				"SELECT finishedAt FROM operations WHERE communityId = ? AND steamId = ? AND state = 'succeeded' ORDER BY finishedAt DESC LIMIT 1"
			)
			.get(communityId, steamId);
		const remaining = last ? last.finishedAt + cooldownSeconds * 1000 - now : 0;
		if (remaining > 0)
			throw new BotUserError(`换边冷却中，请 ${Math.ceil(remaining / 1000)} 秒后再试`);
	}
	prepareMove(
		binding: Binding,
		serverId: string,
		faction: string,
		cost: number,
		code: string,
		now: number
	): Confirmation {
		if (!Number.isSafeInteger(cost) || cost < 0) throw new Error('Invalid move cost');
		const salt = randomBytes(16).toString('hex');
		const confirmation: Confirmation = {
			...binding,
			id: randomUUID(),
			serverId,
			faction,
			cost,
			expiresAt: now + 120_000,
			operationId: null
		};
		this.db
			.query(
				`INSERT INTO confirmations (id, communityId, userId, steamId, serverId, faction, cost, salt, hash, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (communityId, userId, serverId) DO UPDATE SET id = excluded.id, steamId = excluded.steamId, faction = excluded.faction, cost = excluded.cost, salt = excluded.salt, hash = excluded.hash, expiresAt = excluded.expiresAt, operationId = NULL`
			)
			.run(
				confirmation.id,
				binding.communityId,
				binding.userId,
				binding.steamId,
				serverId,
				faction,
				cost,
				salt,
				digest(salt, code),
				confirmation.expiresAt
			);
		return confirmation;
	}
	confirmation(
		communityId: string,
		userId: string,
		serverId: string,
		code: string,
		now: number
	): Confirmation {
		const row = this.db
			.query<ConfirmationRow, [string, string, string]>(
				'SELECT * FROM confirmations WHERE communityId = ? AND userId = ? AND serverId = ?'
			)
			.get(communityId, userId, serverId);
		if (!row || !matches(row.salt, row.hash, code))
			throw new BotUserError('没有找到你的有效确认码\n请先发送 /换边 蓝（或红、绿）');
		if (!row.operationId && row.expiresAt <= now)
			throw new BotUserError('换边确认已过期，请重新发送换边命令');
		return row;
	}
	claimMove(
		confirmationId: string,
		cooldownSeconds: number,
		now: number
	): { operation: MoveOperation; claimed: boolean } {
		return this.db
			.transaction(() => {
				const confirmation = this.db
					.query<Confirmation, [string]>('SELECT * FROM confirmations WHERE id = ?')
					.get(confirmationId);
				if (!confirmation) throw new BotUserError('确认已被新的换边请求替代，请使用最新确认码');
				if (confirmation.operationId)
					return { operation: this.operation(confirmation.operationId)!, claimed: false };
				if (confirmation.expiresAt <= now)
					throw new BotUserError('换边确认已过期，请重新发送换边命令');
				if (
					this.binding(confirmation.communityId, confirmation.userId)?.steamId !==
					confirmation.steamId
				)
					throw new BotUserError('绑定信息已变化，请重新发起换边');
				this.assertCanMove(confirmation.communityId, confirmation.steamId, cooldownSeconds, now);
				const id = randomUUID();
				this.addLedger(
					confirmation.communityId,
					confirmation.userId,
					-confirmation.cost,
					'换边预扣',
					`move:${id}:hold`,
					now
				);
				this.db
					.query(
						`INSERT INTO operations (id, communityId, userId, steamId, serverId, faction, cost, state, createdAt, confirmationId) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`
					)
					.run(
						id,
						confirmation.communityId,
						confirmation.userId,
						confirmation.steamId,
						confirmation.serverId,
						confirmation.faction,
						confirmation.cost,
						now,
						confirmation.id
					);
				this.db
					.query('UPDATE confirmations SET operationId = ? WHERE id = ?')
					.run(id, confirmation.id);
				return { operation: this.operation(id)!, claimed: true };
			})
			.immediate();
	}
	operation(id: string): MoveOperation | null {
		return this.db.query<MoveOperation, [string]>('SELECT * FROM operations WHERE id = ?').get(id);
	}
	markUnknown(id: string, reason: string) {
		this.db
			.query(
				"UPDATE operations SET state = 'unknown', reason = ? WHERE id = ? AND state = 'running'"
			)
			.run(reason, id);
	}
	recoverInterrupted() {
		return this.db
			.query(
				"UPDATE operations SET state = 'unknown', reason = '进程中断，远端执行结果需要人工核实' WHERE state = 'running'"
			)
			.run().changes;
	}
	invalidateConfirmations() {
		return this.db.query('DELETE FROM confirmations WHERE operationId IS NULL').run().changes;
	}
	cancelPending(communityId: string, userId: string, serverId: string): number {
		return this.db
			.transaction(() => {
				const bindings = this.db
					.query('DELETE FROM binding_challenges WHERE communityId=? AND userId=?')
					.run(communityId, userId).changes;
				const moves = this.db
					.query(
						'DELETE FROM confirmations WHERE communityId=? AND userId=? AND serverId=? AND operationId IS NULL'
					)
					.run(communityId, userId, serverId).changes;
				return bindings + moves;
			})
			.immediate();
	}
	listAccounts(limit = 200): (Binding & { balance: number })[] {
		return this.db
			.query<Binding & { balance: number }, [number]>(
				'SELECT b.communityId, b.userId, b.steamId, COALESCE(a.balance, 0) AS balance FROM bindings b LEFT JOIN accounts a ON a.communityId = b.communityId AND a.userId = b.userId ORDER BY b.createdAt DESC LIMIT ?'
			)
			.all(Math.max(1, Math.min(1000, Math.floor(limit))));
	}
	listOperations(limit = 200): MoveOperation[] {
		return this.db
			.query<MoveOperation, [number]>(
				"SELECT id, communityId, userId, steamId, serverId, faction, cost, state, createdAt, finishedAt, reason FROM operations ORDER BY CASE WHEN state = 'unknown' THEN 0 WHEN state = 'running' THEN 1 ELSE 2 END, createdAt DESC LIMIT ?"
			)
			.all(Math.max(1, Math.min(1000, Math.floor(limit))));
	}
	listUnknown(): MoveOperation[] {
		return this.db
			.query<MoveOperation, []>(
				"SELECT * FROM operations WHERE state = 'unknown' ORDER BY createdAt"
			)
			.all();
	}
	resolveOperation(
		id: string,
		outcome: 'succeeded' | 'refunded',
		reason: string,
		now = Date.now()
	): MoveOperation {
		if (!reason.trim()) throw new Error('A reconciliation reason is required');
		return this.db
			.transaction(() => {
				const operation = this.operation(id);
				if (!operation) throw new Error('Operation not found');
				if (operation.state === outcome) return operation;
				if (operation.state === 'succeeded' || operation.state === 'refunded')
					throw new Error('A completed operation cannot be changed');
				if (outcome === 'refunded')
					this.addLedger(
						operation.communityId,
						operation.userId,
						operation.cost,
						reason,
						`move:${id}:refund`,
						now
					);
				this.db
					.query('UPDATE operations SET state = ?, reason = ?, finishedAt = ? WHERE id = ?')
					.run(outcome, reason, now, id);
				return this.operation(id)!;
			})
			.immediate();
	}
}
