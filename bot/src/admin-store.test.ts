import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { AdminConflictError, AdminStore } from './admin-store';
import { BotStore } from './store';
import type { SettingsUpdate } from './admin-contracts';

const folders: string[] = [];
const stores: { close(): void }[] = [];
afterEach(() => {
	stores
		.splice(0)
		.reverse()
		.forEach((store) => store.close());
	folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});
function setup() {
	const folder = mkdtempSync(join(tmpdir(), 'warcon-admin-store-'));
	folders.push(folder);
	const path = join(folder, 'bot.sqlite');
	const bot = new BotStore(path);
	stores.push(bot);
	const key = randomBytes(32).toString('base64');
	const admin = new AdminStore(path, key);
	stores.push(admin);
	return { path, key, admin };
}
const settings = (): SettingsUpdate => ({
	revision: 0,
	servers: [
		{
			id: 'alpha',
			name: '社区服',
			mode: 'wardogs',
			scheme: 'http',
			host: '192.168.1.10',
			port: 7779,
			password: 'private-rcon-password',
			passwordSet: false,
			warconUrl: '',
			warconTokenSet: false
		}
	],
	groups: []
});

describe('encrypted management configuration', () => {
	test('persisted compare-and-swap prevents a stale page from replacing newer configuration', () => {
		const { admin, path, key } = setup();
		expect(admin.publicSettings().revision).toBe(0);
		expect(admin.saveSettings(settings()).revision).toBe(1);
		const first = admin.publicSettings();
		const stale = admin.publicSettings();
		first.servers[0].host = '192.168.1.20';
		expect(admin.saveSettings(first).revision).toBe(2);
		stale.servers[0].name = '另一个页面的名称';
		expect(() => admin.saveSettings(stale)).toThrow(AdminConflictError);
		expect(admin.getSettings().servers[0]).toMatchObject({
			name: '社区服',
			host: '192.168.1.20',
			password: 'private-rcon-password'
		});
		const reopened = new AdminStore(path, key);
		stores.push(reopened);
		expect(reopened.publicSettings().revision).toBe(2);
		expect(() => reopened.saveSettings(stale)).toThrow(AdminConflictError);
		const fresh = reopened.publicSettings();
		fresh.servers[0].name = '新的名称';
		expect(reopened.saveSettings(fresh).revision).toBe(3);
		expect(admin.getSettings().servers[0]).toMatchObject({
			name: '新的名称',
			host: '192.168.1.20'
		});
		const db = new Database(path);
		stores.push(db);
		expect(
			db
				.query<{ count: number }, []>(
					"SELECT count(*) AS count FROM bot_admin_audit WHERE action='settings.updated'"
				)
				.get()!.count
		).toBe(3);
	});
	test('an existing unversioned database migrates without replacing encrypted settings', () => {
		const { admin, path, key } = setup();
		admin.saveSettings(settings());
		const source = new Database(path);
		stores.push(source);
		const encrypted = source
			.query<{ encrypted: string }, []>('SELECT encrypted FROM bot_admin_settings WHERE id=1')
			.get()!.encrypted;
		const legacyPath = join(folders.at(-1)!, 'legacy.sqlite');
		const legacy = new Database(legacyPath, { create: true });
		legacy.exec(
			'CREATE TABLE bot_admin_settings (id INTEGER PRIMARY KEY, encrypted TEXT NOT NULL, updatedAt INTEGER NOT NULL)'
		);
		legacy.query('INSERT INTO bot_admin_settings VALUES(1,?,0)').run(encrypted);
		legacy.close();
		const migrated = new AdminStore(legacyPath, key);
		stores.push(migrated);
		expect(migrated.publicSettings().revision).toBe(0);
		expect(migrated.getSettings().servers[0].password).toBe('private-rcon-password');
		expect(migrated.saveSettings(migrated.publicSettings()).revision).toBe(1);
	});
	test('missing and invalid configuration revisions cannot overwrite settings', () => {
		const { admin } = setup();
		for (const revision of [undefined, '0', -1, 0.5, Number.MAX_SAFE_INTEGER])
			expect(() => admin.saveSettings({ ...settings(), revision } as SettingsUpdate)).toThrow(
				'配置版本'
			);
		expect(admin.publicSettings().revision).toBe(0);
	});
	test('a stale edit of a deleted server reports conflict before trying to preserve its old secret', () => {
		const { admin } = setup();
		const stale = admin.saveSettings(settings());
		admin.saveSettings({ revision: stale.revision, servers: [], groups: [] });
		expect(() => admin.saveSettings(stale)).toThrow(AdminConflictError);
		expect(admin.getSettings().servers).toHaveLength(0);
	});
	test('server secrets stay encrypted, public responses mask them, blank edits preserve by ID', () => {
		const { admin, path } = setup();
		const visible = admin.saveSettings(settings());
		expect(visible.servers[0].passwordSet).toBe(true);
		expect('password' in visible.servers[0]).toBe(false);
		expect('warconToken' in visible.servers[0]).toBe(false);
		admin.saveSettings({
			...visible,
			servers: visible.servers.map((server) => ({ ...server, name: '改名', password: '' }))
		});
		expect(admin.getSettings().servers[0].password).toBe('private-rcon-password');
		const db = new Database(path);
		stores.push(db);
		const encrypted = db
			.query<{ encrypted: string }, []>('SELECT encrypted FROM bot_admin_settings')
			.get()!.encrypted;
		expect(encrypted).not.toContain('private-rcon-password');
		expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 1 });
		const newId = settings();
		newId.revision = admin.publicSettings().revision;
		newId.servers[0].id = 'new';
		newId.servers[0].password = '';
		expect(() => admin.saveSettings(newId)).toThrow('API密码');
	});
	test('wrong keys and tampered ciphertext fail closed', () => {
		const { admin, path } = setup();
		admin.saveSettings(settings());
		expect(() => new AdminStore(path, randomBytes(32).toString('base64'))).toThrow('无法解密');
		expect(() => new AdminStore(path, 'not-a-key')).toThrow('主密钥');
		const db = new Database(path);
		stores.push(db);
		const row = db
			.query<{ encrypted: string }, []>('SELECT encrypted FROM bot_admin_settings')
			.get()!;
		const envelope = JSON.parse(row.encrypted);
		envelope.tag = randomBytes(16).toString('base64');
		db.query('UPDATE bot_admin_settings SET encrypted = ?').run(JSON.stringify(envelope));
		expect(() => admin.getSettings()).toThrow('无法解密');
	});
	test('validation permits empty onboarding but rejects duplicate IDs, malformed URLs, ports and missing references', () => {
		const { admin } = setup();
		expect(admin.getSettings()).toEqual({ servers: [], groups: [] });
		const duplicate = settings();
		duplicate.servers.push({ ...duplicate.servers[0] });
		expect(() => admin.saveSettings(duplicate)).toThrow('ID');
		const host = settings();
		host.servers[0].host = 'http://example.com/path';
		expect(() => admin.saveSettings(host)).toThrow('主机');
		const port = settings();
		port.servers[0].port = 65536;
		expect(() => admin.saveSettings(port)).toThrow('端口');
		const tokenUrl = settings();
		tokenUrl.servers[0].warconUrl = 'https://token:secret@example.com';
		expect(() => admin.saveSettings(tokenUrl)).toThrow('地址');
		const missing = settings();
		missing.groups = [
			{
				groupId: '12345',
				communityId: 'community',
				serverId: 'missing',
				serverName: '社区服',
				timezone: 'Asia/Shanghai',
				checkinPoints: 10,
				moveCost: 20,
				moveCooldownSeconds: 300,
				factions: { 蓝: 'Blue', 红: 'Red', 绿: 'Green' }
			}
		];
		expect(() => admin.saveSettings(missing)).toThrow('已配置');
		missing.groups[0].serverId = 'alpha';
		missing.groups.push({ ...missing.groups[0], groupId: '12346', checkinPoints: 30 });
		expect(() => admin.saveSettings(missing)).toThrow('必须一致');
	});
});

describe('administrator sessions', () => {
	test('bootstrap never overwrites existing credentials; sessions expire and logout revokes tokens', async () => {
		const { admin, path } = setup();
		expect(await admin.initialize('admin', 'very-long-admin-password')).toBe(true);
		expect(await admin.initialize('intruder', 'another-admin-password')).toBe(false);
		expect(await admin.login('admin', 'wrong-password')).toBeNull();
		expect(await admin.login('intruder', 'very-long-admin-password')).toBeNull();
		const login = (await admin.login('admin', 'very-long-admin-password', 1000))!;
		expect(admin.session(login.token, 1001)?.username).toBe('admin');
		expect(admin.session(login.token + 'x', 1001)).toBeNull();
		expect(admin.session(login.token, 1000 + 43_200_000)).toBeNull();
		expect(admin.checkCsrf(login.session, login.session.csrf)).toBe(true);
		expect(admin.checkCsrf(login.session, 'wrong')).toBe(false);
		const db = new Database(path);
		stores.push(db);
		const row = db
			.query<{ tokenHash: string }, []>('SELECT tokenHash FROM bot_admin_sessions')
			.get()!;
		expect(row.tokenHash).not.toBe(login.token);
		expect(
			db.query<{ passwordHash: string }, []>('SELECT passwordHash FROM bot_admin_users').get()!
				.passwordHash
		).toStartWith('$argon2id$');
		admin.logout(login.token);
		expect(admin.session(login.token, 1001)).toBeNull();
	});
});

test('official credentials are encrypted, masked and scoped to AppID; provider switch preserves both setups', () => {
	const { admin, path } = setup();
	const first = admin.saveSettings({
		...settings(),
		messaging: {
			provider: 'official',
			appId: '1234567890',
			appSecret: 'synthetic-official-secret',
			appSecretSet: false
		}
	});
	expect(first.messaging).toMatchObject({
		provider: 'official',
		appId: '1234567890',
		appSecretSet: true
	});
	expect(JSON.stringify(first)).not.toContain('synthetic-official-secret');
	const db = new Database(path);
	stores.push(db);
	expect(
		db.query<{ encrypted: string }, []>('SELECT encrypted FROM bot_admin_settings').get()!.encrypted
	).not.toContain('synthetic-official-secret');
	const standby = admin.saveSettings({
		...first,
		messaging: { ...first.messaging!, provider: 'napcat', appSecret: '' }
	});
	expect(admin.getSettings().messaging?.appSecret).toBe('synthetic-official-secret');
	expect(admin.getSettings().servers[0].password).toBe('private-rcon-password');
	const replacement = admin.saveSettings({
		...standby,
		messaging: { ...standby.messaging!, provider: 'official', appId: '9999999999', appSecret: '' }
	});
	expect(replacement.messaging?.appSecretSet).toBe(false);
	expect(() =>
		admin.saveSettings({
			...replacement,
			messaging: { ...replacement.messaging!, buttons: 'true' as never }
		})
	).toThrow('开关');
});
