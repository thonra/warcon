import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminStore } from './admin-store';
import { BotStore } from './store';
import { AdminApi, type AdminHooks } from './admin-api';
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
const ORIGIN = 'https://bot.example.test';
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
			password: 'never-echo-rcon-secret',
			passwordSet: false,
			warconUrl: '',
			warconTokenSet: false
		}
	],
	groups: []
});
async function setup() {
	const folder = mkdtempSync(join(tmpdir(), 'warcon-admin-api-'));
	folders.push(folder);
	const path = join(folder, 'bot.sqlite');
	const bot = new BotStore(path);
	stores.push(bot);
	const key = randomBytes(32).toString('base64');
	const admin = new AdminStore(path, key);
	stores.push(admin);
	await admin.initialize('admin', 'very-long-admin-password');
	let changed = 0;
	const tested: string[] = [];
	const hooks: AdminHooks = {
		onSettingsChanged: () => {
			changed++;
			bot.invalidateConfirmations();
		},
		testServer: async (server) => {
			tested.push(server.password);
			return { map: 'Bakurani', playerCount: 12, factions: ['Blue', 'Red', 'Green'] };
		},
		backupPath: join(folder, 'backups'),
		selfId: '123456789',
		inboxStats: () => ({ pending: 2 })
	};
	const api = new AdminApi(admin, bot, hooks);
	let auth = '';
	let csrf = '';
	async function call(
		path: string,
		method = 'GET',
		data?: unknown,
		extra: Record<string, string> = {}
	) {
		return (await api.handle(
			new Request(ORIGIN + '/admin/api' + path, {
				method,
				headers: {
					origin: ORIGIN,
					'content-type': 'application/json',
					cookie: auth,
					'x-csrf-token': csrf,
					...extra
				},
				body: data === undefined ? undefined : JSON.stringify(data)
			})
		))!;
	}
	async function login() {
		const response = await call('/login', 'POST', {
			username: 'admin',
			password: 'very-long-admin-password'
		});
		expect(response.status).toBe(200);
		auth = response.headers.get('set-cookie')!.split(';')[0];
		csrf = (await response.json()).csrf;
		return response;
	}
	return { api, admin, bot, key, folder, hooks, tested, changed: () => changed, call, login };
}

describe('admin API boundary', () => {
	test('fixed HTTPS origin accepts TLS termination over HTTP and issues Secure cookies', async () => {
		const f = await setup();
		f.hooks.publicOrigin = 'https://bot.example.test';
		const backend = 'http://127.0.0.1:3100/admin/api';
		const response = (await f.api.handle(
			new Request(backend + '/login', {
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'content-type': 'application/json',
					'x-forwarded-proto': 'http'
				},
				body: JSON.stringify({ username: 'admin', password: 'very-long-admin-password' })
			})
		))!;
		expect(response.status).toBe(200);
		expect(response.headers.get('set-cookie')).toContain('; Secure');
		const auth = response.headers.get('set-cookie')!.split(';')[0];
		const { csrf } = await response.json();
		const write = (origin: string) =>
			f.api.handle(
				new Request(backend + '/config', {
					method: 'PUT',
					headers: {
						origin,
						cookie: auth,
						'x-csrf-token': csrf,
						'content-type': 'application/json',
						'x-forwarded-proto': 'https',
						'x-forwarded-host': 'bot.example.test'
					},
					body: JSON.stringify(settings())
				})
			);
		expect((await write('http://127.0.0.1:3100'))!.status).toBe(403);
		expect((await write('https://evil.test'))!.status).toBe(403);
		expect((await write(ORIGIN))!.status).toBe(200);
		const logout = (await f.api.handle(
			new Request(backend + '/logout', {
				method: 'POST',
				headers: { origin: ORIGIN, cookie: auth, 'x-csrf-token': csrf }
			})
		))!;
		expect(logout.status).toBe(200);
		expect(logout.headers.get('set-cookie')).toContain('; Secure');
	});
	test('without a fixed origin, direct HTTP works and arbitrary forwarded headers are ignored', async () => {
		const f = await setup();
		const direct = 'http://127.0.0.1:3100';
		const login = (origin: string) =>
			f.api.handle(
				new Request(direct + '/admin/api/login', {
					method: 'POST',
					headers: {
						origin,
						'content-type': 'application/json',
						'x-forwarded-proto': 'https',
						'x-forwarded-host': 'bot.example.test'
					},
					body: JSON.stringify({ username: 'admin', password: 'very-long-admin-password' })
				})
			);
		expect((await login(ORIGIN))!.status).toBe(403);
		const response = (await login(direct))!;
		expect(response.status).toBe(200);
		expect(response.headers.get('set-cookie')).not.toContain('; Secure');
	});
	test('stale configuration writes return 409 without invalidating runtime or newer settings', async () => {
		const f = await setup();
		await f.login();
		expect((await f.call('/config')).status).toBe(200);
		const first = await (await f.call('/config', 'PUT', settings())).json();
		expect(first.revision).toBe(1);
		const fresh = {
			...first,
			servers: first.servers.map((s: object) => ({ ...s, host: '192.168.1.20' }))
		};
		const saved = await (await f.call('/config', 'PUT', fresh)).json();
		expect(saved.revision).toBe(2);
		const conflict = await f.call('/config', 'PUT', first);
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ ok: false, code: 'configuration_conflict' });
		expect(f.changed()).toBe(2);
		expect(f.admin.publicSettings().servers[0].host).toBe('192.168.1.20');
		const { revision: _, ...missingRevision } = settings();
		expect((await f.call('/config', 'PUT', missingRevision)).status).toBe(400);
	});
	test('authentication, same-origin and CSRF are mandatory; secure cookie session can be revoked', async () => {
		const f = await setup();
		expect(await f.api.handle(new Request(ORIGIN + '/webhook'))).toBeNull();
		expect((await f.call('/config')).status).toBe(401);
		expect(
			(
				await f.call(
					'/login',
					'POST',
					{ username: 'admin', password: 'very-long-admin-password' },
					{ origin: 'https://evil.test' }
				)
			).status
		).toBe(403);
		expect((await f.call('/login', 'POST', { username: 'admin', password: 'wrong' })).status).toBe(
			401
		);
		const login = await f.login();
		expect(login.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
		expect(login.headers.get('set-cookie')).toContain('Secure');
		expect((await f.call('/session')).status).toBe(200);
		expect((await f.call('/config', 'PUT', settings(), { 'x-csrf-token': '' })).status).toBe(403);
		expect(
			(await f.call('/config', 'PUT', settings(), { origin: 'https://evil.test' })).status
		).toBe(403);
		expect(f.admin.getSettings().servers).toHaveLength(0);
		expect((await f.call('/logout', 'POST', {})).status).toBe(200);
		expect((await f.call('/session')).status).toBe(401);
	});
	test('saving validates and masks configuration, invalidates old quotes, connection tests use saved secrets only', async () => {
		const f = await setup();
		await f.login();
		f.bot.beginBinding('c', 'q', '76561198000000001', '123456', 1000);
		const binding = f.bot.verifyBinding('c', 'q', '123456', 1001);
		f.bot.prepareMove(binding, 'alpha', 'Blue', 20, '234567', 1002);
		const saved = await f.call('/config', 'PUT', settings());
		expect(() => f.bot.confirmation('c', 'q', 'alpha', '234567', 1003)).toThrow('没有找到');
		expect(saved.status).toBe(200);
		const visible = await saved.json();
		expect(visible.servers[0].passwordSet).toBe(true);
		expect(JSON.stringify(visible)).not.toContain('never-echo-rcon-secret');
		expect(f.changed()).toBe(1);
		const tested = await f.call('/test-server', 'POST', {
			id: 'alpha',
			password: 'attacker-override'
		});
		expect(await tested.json()).toEqual({
			ok: true,
			map: 'Bakurani',
			playerCount: 12,
			factions: ['Blue', 'Red', 'Green']
		});
		expect(f.tested).toEqual(['never-echo-rcon-secret']);
		f.hooks.testServer = async () => {
			throw new Error('never-echo-rcon-secret');
		};
		expect(await (await f.call('/test-server', 'POST', { id: 'alpha' })).text()).not.toContain(
			'never-echo-rcon-secret'
		);
		const invalid = settings();
		invalid.revision = f.admin.publicSettings().revision;
		invalid.servers[0].port = 0;
		expect((await f.call('/config', 'PUT', invalid)).status).toBe(400);
		expect(f.changed()).toBe(1);
	});
	test('unknown operation reconciliation is authenticated and cannot refund running or completed operations', async () => {
		const f = await setup();
		await f.login();
		f.bot.beginBinding('c', 'q', '76561198000000001', '123456', 1000);
		const binding = f.bot.verifyBinding('c', 'q', '123456', 1001);
		f.bot.checkin('c', 'q', '2026-10-23', 30, 1002);
		const quote = f.bot.prepareMove(binding, 'alpha', 'Blue', 20, '234567', 1003);
		const operation = f.bot.claimMove(quote.id, 0, 1004).operation;
		const route = `/operations/${operation.id}/resolve`;
		expect(
			(await f.call(route, 'POST', { outcome: 'refunded', reason: '核实未执行换边' })).status
		).toBe(409);
		expect(f.bot.balance('c', 'q')).toBe(10);
		f.bot.markUnknown(operation.id, 'timeout');
		expect((await f.call(route, 'POST', { outcome: 'refunded', reason: '' })).status).toBe(400);
		expect(
			(await f.call(route, 'POST', { outcome: 'refunded', reason: '核实未执行换边' })).status
		).toBe(200);
		expect(f.bot.balance('c', 'q')).toBe(30);
		expect(f.bot.operation(operation.id)?.reason).toContain('管理员 admin');
		expect(
			(await f.call(route, 'POST', { outcome: 'refunded', reason: '重复退款不得再次执行' })).status
		).toBe(409);
		const overview = await (await f.call('/overview')).json();
		expect(overview.accounts[0]).toEqual({
			communityId: 'c',
			userId: 'q',
			steamId: '76561198000000001',
			balance: 30
		});
		expect(overview.operations[0].state).toBe('refunded');
		expect(overview.inbox.pending).toBe(2);
	});
	test('authenticated backup restores current encrypted config and leaves no temporary snapshot', async () => {
		const f = await setup();
		expect((await f.call('/backup')).status).toBe(401);
		await f.login();
		await f.call('/config', 'PUT', settings());
		const response = await f.call('/backup');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-disposition')).toContain('attachment;');
		const bytes = Buffer.from(await response.arrayBuffer());
		expect(bytes.toString()).not.toContain('never-echo-rcon-secret');
		const restoredPath = join(f.folder, 'restore.sqlite');
		writeFileSync(restoredPath, bytes);
		const restored = new AdminStore(restoredPath, f.key);
		stores.push(restored);
		expect(restored.getSettings().servers[0].password).toBe('never-echo-rcon-secret');
		expect(readdirSync(f.hooks.backupPath)).toEqual([]);
		expect((await f.call('/backup')).status).toBe(429);
	});
	test('payload and global login budgets are bounded', async () => {
		const f = await setup();
		expect(
			(await f.call('/login', 'POST', { username: 'admin', password: 'x'.repeat(70_000) })).status
		).toBe(413);
		for (let i = 0; i < 19; i++)
			expect(
				(await f.call('/login', 'POST', { username: 'x'.repeat(65), password: 'x' })).status
			).toBe(400);
		expect(
			(await f.call('/login', 'POST', { username: 'admin', password: 'very-long-admin-password' }))
				.status
		).toBe(429);
	});
});
