import { expect, test } from 'bun:test';
import { adminOrigin, httpUrl, loadConfig, parseGroups, qqId } from './config';
const group = {
	groupId: '123456',
	communityId: 'cn',
	serverId: 'server-id',
	serverName: '社区服',
	factions: { 蓝: 'Blue', 红: 'Red', 绿: 'Green' }
};
test('config defaults are explicit and same-community economics cannot conflict', () => {
	expect(parseGroups([group])[0]).toMatchObject({
		checkinPoints: 10,
		moveCost: 20,
		moveCooldownSeconds: 300,
		timezone: 'Asia/Shanghai'
	});
	for (const change of [
		{ checkinPoints: 11 },
		{ timezone: 'Asia/Tokyo' },
		{ moveCost: 1 },
		{ moveCooldownSeconds: 1 }
	])
		expect(() => parseGroups([group, { ...group, groupId: '123457', ...change }])).toThrow();
	expect(parseGroups([group, { ...group, groupId: '123457' }])).toHaveLength(2);
});
test('invalid IDs, numeric overflow, ambiguous factions and unsafe URLs fail closed', () => {
	expect(qqId(9007199254740992)).toBeNull();
	expect(qqId('01')).toBeNull();
	for (const entry of [
		{ ...group, groupId: 'x' },
		{ ...group, moveCost: -1 },
		{ ...group, timezone: 'bad' },
		{ ...group, factions: { 蓝: 'X', 红: 'X', 绿: 'Y' } }
	])
		expect(() => parseGroups([entry])).toThrow();
	expect(() => parseGroups([group, group])).toThrow();
	for (const url of [
		'file:///tmp/x',
		'https://user:pass@site.test',
		'https://site.test?token=x',
		'https://site.test/#x'
	])
		expect(() => httpUrl(url)).toThrow();
	expect(httpUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
});
test('fixed admin origin is optional, normalized, and rejects paths or credentials', () => {
	expect(adminOrigin('https://BOT.example.test:443/')).toBe('https://bot.example.test');
	expect(adminOrigin('http://127.0.0.1:3100')).toBe('http://127.0.0.1:3100');
	for (const value of [
		'file:///tmp/x',
		'https://bot.test/admin',
		'https://user:pass@bot.test',
		'https://bot.test?token=x',
		'https://bot.test/#x',
		'bot.test'
	])
		expect(() => adminOrigin(value)).toThrow('QQ_ADMIN_ORIGIN');
	const env = {
		QQ_BOT_MANAGED: 'true',
		QQ_BOT_SELF_ID: '123456789',
		QQ_ADMIN_PASSWORD: 'admin-password',
		QQ_BOT_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
		NAPCAT_WEBHOOK_SECRET: 'x'.repeat(24),
		NAPCAT_API_URL: 'http://127.0.0.1:3000',
		NAPCAT_API_TOKEN: 'y'.repeat(24)
	};
	expect(loadConfig(env).managed?.origin).toBeUndefined();
	expect(loadConfig({ ...env, QQ_ADMIN_ORIGIN: ' https://bot.test/ ' }).managed?.origin).toBe(
		'https://bot.test'
	);
	expect(() => loadConfig({ ...env, QQ_ADMIN_ORIGIN: 'https://bot.test/admin' })).toThrow(
		'QQ_ADMIN_ORIGIN'
	);
});
