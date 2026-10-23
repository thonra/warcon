import { Database } from 'bun:sqlite';
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { httpUrl, officialId, parseGroups } from './config';
import { validateReplies, type ReplyOverrides } from './reply-copy';
import { defaultMessaging } from './admin-contracts';
import type {
	ManagedServer,
	ManagedSettings,
	PublicSettings,
	SettingsUpdate
} from './admin-contracts';

export class AdminValidationError extends Error {}
export class AdminConflictError extends Error {
	constructor() {
		super('配置已被其他页面更新，请刷新后重新编辑。');
	}
}
export interface AdminSession {
	username: string;
	csrf: string;
	expiresAt: number;
}
type SessionRow = AdminSession & { tokenHash: string };
const SESSION_MS = 12 * 60 * 60 * 1000;
const AAD = Buffer.from('warcon-bot-admin-settings:v1');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const constantEqual = (a: string, b: string) =>
	timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));

/** Secrets are encrypted in the same SQLite backup as points; the master key lives outside SQLite. */
export class AdminStore {
	private readonly db: Database;
	private readonly key: Buffer;
	constructor(path: string, masterKey: string) {
		this.key = Buffer.from(masterKey, 'base64');
		if (!/^[A-Za-z0-9+/]{43}=$/.test(masterKey) || this.key.length !== 32)
			throw new Error('管理后台主密钥必须是32字节随机数据的Base64编码。');
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new Database(path, { create: true, strict: true });
		this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS bot_admin_users (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, passwordHash TEXT NOT NULL, createdAt INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS bot_admin_sessions (tokenHash TEXT PRIMARY KEY, username TEXT NOT NULL, csrf TEXT NOT NULL, expiresAt INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS bot_admin_settings (id INTEGER PRIMARY KEY CHECK (id = 1), encrypted TEXT NOT NULL, updatedAt INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0));
			CREATE TABLE IF NOT EXISTS bot_admin_audit (id INTEGER PRIMARY KEY, username TEXT NOT NULL, action TEXT NOT NULL, createdAt INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS bot_admin_copy (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, templates TEXT NOT NULL DEFAULT '{}');
			CREATE TABLE IF NOT EXISTS bot_admin_menu_history (id INTEGER PRIMARY KEY, appId TEXT NOT NULL, username TEXT NOT NULL, snapshot TEXT NOT NULL, createdAt INTEGER NOT NULL);
		`);
		this.db.exec('INSERT OR IGNORE INTO bot_admin_copy(id) VALUES(1)');
		// Existing deployments keep their encrypted settings; the first versioned edit starts at 0.
		const columns = this.db
			.query<{ name: string }, []>('PRAGMA table_info(bot_admin_settings)')
			.all();
		if (!columns.some((column) => column.name === 'revision'))
			this.db.exec(
				'ALTER TABLE bot_admin_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)'
			);
		this.db
			.query('INSERT OR IGNORE INTO bot_admin_settings (id, encrypted, updatedAt) VALUES (1, ?, ?)')
			.run(this.encrypt({ servers: [], groups: [] }), Date.now());
		// Fail startup for a wrong key instead of silently replacing existing credentials.
		try {
			this.getSettings();
		} catch (error) {
			this.db.close();
			this.key.fill(0);
			throw error;
		}
	}
	close() {
		this.db.close();
		this.key.fill(0);
	}
	async initialize(username: string, password: string): Promise<boolean> {
		if (this.db.query('SELECT 1 FROM bot_admin_users WHERE id = 1').get()) return false;
		if (!/^[\p{L}\p{N}_.@-]{3,64}$/u.test(username))
			throw new AdminValidationError('管理员用户名需为3至64位字母、数字或 _.@-。');
		if (typeof password !== 'string' || password.length < 12 || password.length > 256)
			throw new AdminValidationError('管理员密码需为12至256个字符。');
		const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
		const result = this.db
			.query(
				'INSERT OR IGNORE INTO bot_admin_users (id, username, passwordHash, createdAt) VALUES (1, ?, ?, ?)'
			)
			.run(username, passwordHash, Date.now());
		return result.changes === 1;
	}
	private encrypt(settings: ManagedSettings) {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.key, iv);
		cipher.setAAD(AAD);
		const encrypted = Buffer.concat([
			cipher.update(JSON.stringify(settings), 'utf8'),
			cipher.final()
		]);
		return JSON.stringify({
			v: 1,
			iv: iv.toString('base64'),
			tag: cipher.getAuthTag().toString('base64'),
			data: encrypted.toString('base64')
		});
	}
	private readSettings(): { settings: ManagedSettings; revision: number } {
		try {
			const row = this.db
				.query<{ encrypted: string; revision: number }, []>(
					'SELECT encrypted, revision FROM bot_admin_settings WHERE id = 1'
				)
				.get()!;
			if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error();
			const envelope = JSON.parse(row.encrypted);
			if (envelope.v !== 1) throw new Error();
			const decipher = createDecipheriv(
				'aes-256-gcm',
				this.key,
				Buffer.from(envelope.iv, 'base64')
			);
			decipher.setAAD(AAD);
			decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
			const settings = JSON.parse(
				Buffer.concat([
					decipher.update(Buffer.from(envelope.data, 'base64')),
					decipher.final()
				]).toString('utf8')
			) as ManagedSettings;
			return { settings, revision: row.revision };
		} catch {
			throw new Error('无法解密后台配置，请核对主密钥与数据库备份。');
		}
	}
	getSettings(): ManagedSettings {
		return this.readSettings().settings;
	}
	getReplies(): { revision: number; templates: ReplyOverrides } {
		const row = this.db
			.query<{ revision: number; templates: string }, []>(
				'SELECT revision,templates FROM bot_admin_copy WHERE id=1'
			)
			.get()!;
		return { revision: row.revision, templates: JSON.parse(row.templates) };
	}
	saveReplies(revision: unknown, templates: unknown, actor = 'local') {
		if (
			!Number.isSafeInteger(revision) ||
			Number(revision) < 0 ||
			Number(revision) >= Number.MAX_SAFE_INTEGER
		)
			throw new AdminValidationError('文案版本无效，请重新读取');
		const next = validateReplies(templates);
		this.db
			.transaction(() => {
				const result = this.db
					.query(
						'UPDATE bot_admin_copy SET templates=?,revision=revision+1 WHERE id=1 AND revision=?'
					)
					.run(JSON.stringify(next), revision as number);
				if (result.changes !== 1) throw new AdminConflictError();
				this.audit(actor, 'replies.updated');
			})
			.immediate();
		return this.getReplies();
	}
	menuCheckpoint(appId: string, snapshot: unknown, actor: string) {
		this.db
			.query(
				'INSERT INTO bot_admin_menu_history(appId,username,snapshot,createdAt) VALUES(?,?,?,?)'
			)
			.run(appId, actor, JSON.stringify(snapshot), Date.now());
	}
	publicSettings(): PublicSettings {
		const { settings, revision } = this.readSettings();
		return {
			revision,
			messaging: (() => {
				const { appSecret, ...value } = settings.messaging ?? defaultMessaging();
				return { ...value, appSecretSet: Boolean(appSecret) };
			})(),
			groups: settings.groups,
			servers: settings.servers.map(({ password, warconToken, ...server }) => ({
				...server,
				passwordSet: Boolean(password),
				warconTokenSet: Boolean(warconToken)
			}))
		};
	}
	saveSettings(update: SettingsUpdate, actor = 'local'): PublicSettings {
		if (
			!update ||
			!Number.isSafeInteger(update.revision) ||
			update.revision < 0 ||
			update.revision >= Number.MAX_SAFE_INTEGER
		)
			throw new AdminValidationError('配置版本无效，请刷新页面后重新编辑。');
		this.db
			.transaction(() => {
				const current = this.db
					.query<{ revision: number }, []>('SELECT revision FROM bot_admin_settings WHERE id = 1')
					.get();
				if (!current || current.revision !== update.revision) throw new AdminConflictError();
				// Validate and resolve blank secrets against this same locked configuration version.
				const settings = this.validateSettings(update);
				const result = this.db
					.query(
						'UPDATE bot_admin_settings SET encrypted = ?, updatedAt = ?, revision = revision + 1 WHERE id = 1 AND revision = ?'
					)
					.run(this.encrypt(settings), Date.now(), update.revision);
				if (result.changes !== 1) throw new AdminConflictError();
				this.audit(actor, 'settings.updated');
			})
			.immediate();
		return this.publicSettings();
	}
	private validateSettings(update: SettingsUpdate): ManagedSettings {
		if (
			!update ||
			!Array.isArray(update.servers) ||
			!Array.isArray(update.groups) ||
			update.servers.length > 100 ||
			update.groups.length > 1000
		)
			throw new AdminValidationError(
				'配置需包含 servers 和 groups 数组，服务器不超过100个，群不超过1000个。'
			);
		const old = new Map(this.getSettings().servers.map((server) => [server.id, server]));
		const ids = new Set<string>();
		const text = (value: unknown, label: string, max: number, allowEmpty = false) => {
			if (
				typeof value !== 'string' ||
				(!allowEmpty && !value.trim()) ||
				value.length > max ||
				/[\x00-\x1f\x7f]/.test(value)
			)
				throw new AdminValidationError(`${label}格式无效。`);
			return value.trim();
		};
		const servers: ManagedServer[] = update.servers.map((raw) => {
			if (
				!raw ||
				typeof raw !== 'object' ||
				typeof raw.id !== 'string' ||
				!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(raw.id) ||
				ids.has(raw.id)
			)
				throw new AdminValidationError('服务器ID必须唯一，且只包含字母、数字、下划线或短横线。');
			ids.add(raw.id);
			if (raw.mode !== 'wardogs' && raw.mode !== 'warcon')
				throw new AdminValidationError('服务器接入方式无效。');
			if (raw.scheme !== 'http' && raw.scheme !== 'https')
				throw new AdminValidationError('协议只支持 HTTP 或 HTTPS。');
			if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535)
				throw new AdminValidationError('端口必须为1至65535的整数。');
			let host = text(raw.host, '主机地址', 253, raw.mode === 'warcon');
			if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
			if (
				host &&
				!isIP(host) &&
				!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
					host
				)
			)
				throw new AdminValidationError('主机只填写IP或域名，不要包含协议、端口或路径。');
			let warconUrl = text(raw.warconUrl, 'Warcon地址', 2048, raw.mode === 'wardogs');
			if (warconUrl) {
				try {
					warconUrl = httpUrl(warconUrl);
				} catch {
					throw new AdminValidationError(
						'Warcon地址必须是有效HTTP(S)地址，不能包含凭据、查询或片段。'
					);
				}
			}
			const secret = (value: unknown, previous: string | undefined, label: string) => {
				if (value === undefined || value === '') return previous ?? '';
				if (typeof value !== 'string' || value.length > 4096 || /[\r\n\x00]/.test(value))
					throw new AdminValidationError(`${label}格式无效。`);
				return value;
			};
			const password = secret(raw.password, old.get(raw.id)?.password, 'API密码');
			const warconToken = secret(raw.warconToken, old.get(raw.id)?.warconToken, 'Warcon令牌');
			const warconServerId = raw.warconServerId ?? old.get(raw.id)?.warconServerId;
			if (
				warconServerId !== undefined &&
				(typeof warconServerId !== 'string' ||
					(warconServerId !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(warconServerId)))
			)
				throw new AdminValidationError('Warcon 管理服务器ID格式无效');
			if (raw.mode === 'wardogs' && !password)
				throw new AdminValidationError('请填写WARDOGS API密码。');
			if (raw.mode === 'warcon' && !warconToken)
				throw new AdminValidationError('请填写Warcon API令牌。');
			return {
				id: raw.id,
				name: text(raw.name, '服务器名称', 100),
				mode: raw.mode,
				scheme: raw.scheme,
				host,
				port: raw.port,
				password,
				warconUrl,
				warconToken,
				...(warconServerId ? { warconServerId } : {})
			};
		});
		let groups;
		try {
			groups = update.groups.length ? parseGroups(update.groups) : [];
		} catch (error) {
			throw new AdminValidationError(error instanceof Error ? error.message : '群配置无效。');
		}
		if (groups.some((group) => !ids.has(group.serverId)))
			throw new AdminValidationError('每个群必须绑定已配置的服务器。');
		const previous = this.getSettings().messaging ?? defaultMessaging();
		let messaging = previous;
		if (update.messaging !== undefined) {
			const raw = update.messaging;
			if (
				!raw ||
				!['napcat', 'official'].includes(raw.provider) ||
				typeof raw.appId !== 'string' ||
				(raw.appId && !/^[0-9]{5,20}$/.test(raw.appId))
			)
				throw new AdminValidationError('QQ 接入方式或 AppID 格式无效。');
			if (
				raw.appSecret !== undefined &&
				(typeof raw.appSecret !== 'string' ||
					raw.appSecret.length > 256 ||
					/\s|[\x00-\x1f\x7f]/.test(raw.appSecret))
			)
				throw new AdminValidationError('AppSecret 格式无效，请勿包含空格或换行。');
			if (raw.buttons !== undefined && typeof raw.buttons !== 'boolean')
				throw new AdminValidationError('快捷按钮开关无效。');
			const privateTests =
				raw.privateTests ?? (raw.appId === previous.appId ? (previous.privateTests ?? []) : []);
			if (!Array.isArray(privateTests) || privateTests.length > 20)
				throw new AdminValidationError('私聊测试账号不能超过20个。');
			const testers = new Set<string>();
			for (const tester of privateTests) {
				if (
					!tester ||
					tester.appId !== raw.appId ||
					!raw.appId ||
					!officialId(tester.userOpenid) ||
					testers.has(tester.userOpenid) ||
					!groups.some((g) => g.groupId === tester.groupId)
				)
					throw new AdminValidationError(
						'私聊测试账号需唯一、属于当前 AppID，并关联有效群组配置。'
					);
				testers.add(tester.userOpenid);
			}
			messaging = {
				provider: raw.provider,
				appId: raw.appId,
				appSecret: raw.appSecret || (raw.appId === previous.appId ? previous.appSecret : ''),
				buttons: raw.buttons ?? previous.buttons ?? true,
				privateTests: privateTests.map(({ appId, userOpenid, groupId }) => ({
					appId,
					userOpenid,
					groupId
				}))
			};
		}
		if (messaging.privateTests?.some((t) => !groups.some((g) => g.groupId === t.groupId)))
			throw new AdminValidationError('请先移除该群配置关联的私聊测试账号。');
		return { servers, groups, messaging };
	}
	async login(
		username: string,
		password: string,
		now = Date.now()
	): Promise<{ token: string; session: AdminSession } | null> {
		const user = this.db
			.query<{ username: string; passwordHash: string }, []>(
				'SELECT username, passwordHash FROM bot_admin_users WHERE id = 1'
			)
			.get();
		if (!user) return null;
		const valid = await Bun.password.verify(password, user.passwordHash);
		if (!valid || !constantEqual(username, user.username)) return null;
		const token = randomBytes(32).toString('base64url');
		const session = {
			username: user.username,
			csrf: randomBytes(32).toString('base64url'),
			expiresAt: now + SESSION_MS
		};
		this.db
			.transaction(() => {
				this.db.query('DELETE FROM bot_admin_sessions WHERE expiresAt <= ?').run(now);
				this.db
					.query(
						'INSERT INTO bot_admin_sessions (tokenHash, username, csrf, expiresAt) VALUES (?, ?, ?, ?)'
					)
					.run(hash(token), session.username, session.csrf, session.expiresAt);
				this.audit(username, 'session.login');
			})
			.immediate();
		return { token, session };
	}
	session(token: string, now = Date.now()): AdminSession | null {
		if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
		const tokenHash = hash(token);
		const row = this.db
			.query<SessionRow, [string]>('SELECT * FROM bot_admin_sessions WHERE tokenHash = ?')
			.get(tokenHash);
		if (!row || row.expiresAt <= now || !constantEqual(row.tokenHash, tokenHash)) return null;
		return { username: row.username, csrf: row.csrf, expiresAt: row.expiresAt };
	}
	logout(token: string) {
		this.db.query('DELETE FROM bot_admin_sessions WHERE tokenHash = ?').run(hash(token));
	}
	checkCsrf(session: AdminSession, token: string) {
		return constantEqual(session.csrf, token);
	}
	audit(username: string, action: string) {
		this.db
			.query('INSERT INTO bot_admin_audit (username, action, createdAt) VALUES (?, ?, ?)')
			.run(username, action, Date.now());
	}
}
