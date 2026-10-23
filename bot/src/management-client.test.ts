import { expect, test } from 'bun:test';
import {
	ManagementClient,
	editConfigScalar,
	configScalar,
	utcTime,
	managementView
} from './management-client';
import { WarconClient } from './warcon';
import { validateMenu } from './official-menu';
import type { GroupConfig } from './contracts';
import type { ManagedServer } from './admin-contracts';
const group: GroupConfig = {
	groupId: '10000',
	communityId: 'c',
	serverId: 's',
	serverName: 'Alpha',
	timezone: 'Asia/Shanghai',
	checkinPoints: 10,
	moveCost: 3,
	moveCooldownSeconds: 300,
	factions: { 蓝: 'Blue', 红: 'Red', 绿: 'Green' }
};
const lifecycle = '/Script/WDGame.WDServerLifecycleSubsystem';
const server: ManagedServer = {
	id: 's',
	name: 'A',
	mode: 'wardogs',
	scheme: 'http',
	host: 'game.test',
	port: 7779,
	password: 'synthetic-rcon',
	warconUrl: 'https://panel.test',
	warconToken: 'synthetic-key',
	warconServerId: 'native'
};
function fixture() {
	let text =
		';keep\n[/Script/WDGame.WDGameSession]\nPassword=untouched-secret\nServerName=Old\n[' +
		lifecycle +
		']\nRestartTimeUtc=01:00\n';
	let revision = 'v1';
	let rules: any[] = [];
	const calls: { path: string; method: string; body: any }[] = [];
	const client = new ManagementClient(
		() => [server],
		() =>
			new WarconClient({
				baseUrl: server.warconUrl,
				token: server.warconToken,
				fetch: async (input, init) => {
					const path = new URL(String(input)).pathname;
					const method = init?.method ?? 'GET';
					const body = init?.body ? JSON.parse(String(init.body)) : undefined;
					calls.push({ path, method, body });
					let response: any;
					if (path.endsWith('/rcon/config'))
						response = { ok: true, action: 'config', result: { text, revision, writable: true } };
					else if (path.endsWith('/rcon/configApply')) {
						expect(body.revision).toBe(revision);
						text = body.text;
						revision = 'v2';
						response = { ok: true, action: 'configApply', result: { ok: true } };
					} else if (path.endsWith('/triggers') && method === 'GET')
						response = { ok: true, triggers: rules };
					else if (path.includes('/triggers'))
						response = { ok: true, trigger: { id: 'welcome-id' } };
					else if (path.endsWith('/rcon/rotation'))
						response = {
							ok: true,
							action: 'rotation',
							result: { entries: [{ map: 'a' }, { map: 'b' }] }
						};
					else response = { ok: true, result: { message: 'ok' } };
					return Response.json(response);
				}
			})
	);
	return {
		client,
		calls,
		setRevision: (v: string) => (revision = v),
		setRules: (v: any[]) => (rules = v),
		text: () => text
	};
}
test('daily restart writes only RestartTimeUtc with revision, UTC conversion and readback', async () => {
	const f = fixture();
	const p = await f.client.prepare('s', '每日重启', '07:00', group);
	expect(f.calls.every((x) => x.method === 'GET')).toBe(true);
	expect(p.summary).toContain('23:00');
	let guarded = 0;
	const out = await f.client.execute('s', '每日重启', '07:00', group, p.expected, () => {
		guarded++;
	});
	expect(out).toContain('23:00');
	expect(guarded).toBe(1);
	expect(f.text()).toContain('Password=untouched-secret');
	expect(f.text()).toContain(';keep');
	expect(configScalar(f.text(), lifecycle, 'RestartTimeUtc')).toBe('23:00');
	expect(f.calls.filter((x) => x.method === 'POST')).toHaveLength(1);
});
test('changed config versions and revoked authority stop the mutation after quote', async () => {
	const f = fixture();
	const p = await f.client.prepare('s', '每日重启', '07:00', group);
	f.setRevision('different');
	await expect(
		f.client.execute('s', '每日重启', '07:00', group, p.expected, () => {})
	).rejects.toThrow('变化');
	expect(f.calls.some((x) => x.method === 'POST')).toBe(false);
	const p2 = await f.client.prepare('s', '踢出', '76561198000000001 reason', group);
	await expect(
		f.client.execute('s', '踢出', '76561198000000001 reason', group, p2.expected, () => {
			throw new Error('revoked');
		})
	).rejects.toThrow('revoked');
	expect(f.calls.some((x) => x.method === 'POST')).toBe(false);
});
test('welcome updates one existing rule and preserves its delivery options', async () => {
	const f = fixture();
	f.setRules([
		{
			id: 'welcome-id',
			kind: 'welcome',
			enabled: false,
			config: { message: 'old', onlyFirstVisit: true, afterFaction: true }
		}
	]);
	const p = await f.client.prepare('s', '欢迎私信', '欢迎 {name}', group);
	await f.client.execute('s', '欢迎私信', '欢迎 {name}', group, p.expected, () => {});
	const writes = f.calls.filter((x) => x.method !== 'GET');
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		method: 'PATCH',
		path: '/api/servers/native/triggers/welcome-id',
		body: { config: { message: '欢迎 {name}', onlyFirstVisit: true, afterFaction: true } }
	});
	f.setRules([
		{ id: '1', kind: 'welcome' },
		{ id: '2', kind: 'welcome' }
	]);
	await expect(f.client.prepare('s', '欢迎私信', 'new', group)).rejects.toThrow('多条');
});
test('scalar edits cannot inject sections and time zones and map indices are explicit', async () => {
	expect(utcTime('00:30', 'Asia/Tokyo')).toBe('15:30');
	expect(utcTime('23:00', 'UTC-04:00')).toBe('03:00');
	expect(() => utcTime('24:00', 'UTC')).toThrow();
	expect(() => utcTime('07:00', 'America/New_York')).toThrow();
	expect(() => editConfigScalar('text', lifecycle, 'RestartTimeUtc', '\n[evil]')).toThrow();
	const edited = editConfigScalar(
		'[Other]\nRestartTimeUtc=09:00\n[' +
			lifecycle +
			']\nRestartTimeUtc=01:00\nRestartTimeUtc=02:00\n',
		lifecycle,
		'RestartTimeUtc',
		'03:00'
	);
	expect(edited).toContain('[Other]\nRestartTimeUtc=09:00');
	expect(edited.match(/RestartTimeUtc=/g)).toHaveLength(2);
	const f = fixture();
	const p = await f.client.prepare('s', '轮换删除', '2', group);
	await f.client.execute('s', '轮换删除', '2', group, p.expected, () => {});
	expect(f.calls.find((x) => x.path.endsWith('/rotationRemove'))?.body.index).toBe(1);
});
test('management output removes secret/raw/transport fields and menus reject staff commands', () => {
	const value = managementView({
		name: 'Alice',
		raw: { password: 'bad' },
		token: 'bad',
		dossier: { steamId: '76561198000000001', risk: { score: 50 } },
		config: { threshold: 100, password: 'secret', callbackUrl: 'secret' }
	});
	expect(value).toContain('Alice');
	expect(value).toContain('threshold：100');
	expect(value).not.toContain('secret');
	expect(value).not.toContain('bad');
	expect(() =>
		validateMenu([{ type: 'command', name: '踢出', desc: 'staff', only_admin: true }])
	).toThrow('管理命令');
});
