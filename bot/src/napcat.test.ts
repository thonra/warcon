import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGroups, type BotConfig } from './config';
import { Inbox } from './inbox';
import { NapCatBot, parseMessage, type Fetcher } from './napcat';
import { BotStore } from './store';
import { CommandHandler } from './commands';
import type { WarconPort } from './contracts';

const now = 1792700000000;
const groups = parseGroups([
	{
		groupId: '123456',
		communityId: 'test',
		serverId: 's1',
		serverName: '测试服',
		factions: { 蓝: 'Blue', 红: 'Red', 绿: 'Green' }
	}
]);
const config: BotConfig = {
	host: '127.0.0.1',
	port: 3100,
	databasePath: ':memory:',
	selfId: '999999',
	webhookSecret: 'test-signature-secret-at-least24',
	napcatUrl: 'http://napcat.test',
	napcatToken: 'private-token',
	warconUrl: 'http://warcon.test',
	warconToken: 'wc-token',
	groups
};
const event = (text = '/使用帮助', id = 1) => ({
	post_type: 'message',
	message_type: 'group',
	sub_type: 'normal',
	self_id: 999999,
	group_id: 123456,
	user_id: 123457,
	message_id: id,
	time: now / 1000,
	message: [{ type: 'text', data: { text } }]
});
function request(payload: unknown, signature = true) {
	const body = JSON.stringify(payload);
	return new Request('http://bot.test/onebot/events', {
		method: 'POST',
		body,
		headers: {
			'x-self-id': config.selfId,
			'x-signature': signature
				? 'sha1=' + createHmac('sha1', config.webhookSecret).update(body).digest('hex')
				: 'sha1=' + '0'.repeat(40)
		}
	});
}
const resources: { close(): void }[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const r of resources.splice(0)) r.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const makeInbox = (path = ':memory:') => {
	const inbox = new Inbox(path);
	resources.push(inbox);
	return inbox;
};
const sent: string[] = [];
const sender = (async (_: unknown, init?: RequestInit) => {
	sent.push(String(init?.body));
	return Response.json({ status: 'ok', retcode: 0, data: { message_id: 123 } });
}) as Fetcher;

test('signed group command is durable before ack, replies use typed text segments', async () => {
	sent.length = 0;
	let calls = 0;
	const inbox = makeInbox();
	const bot = new NapCatBot(
		config,
		inbox,
		{
			handle: async () => {
				calls++;
				return '[CQ:at,qq=all]';
			}
		},
		sender,
		() => now
	);
	expect((await bot.receive(request(event()))).status).toBe(200);
	expect(calls).toBe(0);
	await bot.pump();
	expect(calls).toBe(1);
	expect(JSON.parse(sent[0]).message[1]).toEqual({
		type: 'text',
		data: { text: '\n[CQ:at,qq=all]' }
	});
	expect(inbox.stats()).toEqual({ sent: 1 });
});

test('duplicate callbacks including concurrent pumps never repeat a handler', async () => {
	let calls = 0;
	const inbox = makeInbox();
	const bot = new NapCatBot(
		config,
		inbox,
		{
			handle: async () => {
				calls++;
				await new Promise((r) => setTimeout(r, 5));
				return '完成';
			}
		},
		sender,
		() => now
	);
	await Promise.all([bot.receive(request(event())), bot.receive(request(event()))]);
	await Promise.all([bot.pump(), bot.pump()]);
	await bot.receive(request(event()));
	await bot.pump();
	expect(calls).toBe(1);
});

test('invalid signature, wrong group/bot, anonymous/forwarded and stale events cause no action', async () => {
	let calls = 0;
	const inbox = makeInbox();
	const bot = new NapCatBot(
		config,
		inbox,
		{
			handle: async () => {
				calls++;
				return 'bad';
			}
		},
		sender,
		() => now
	);
	expect((await bot.receive(request(event(), false))).status).toBe(401);
	for (const modified of [
		{ ...event(), group_id: 888888 },
		{ ...event(), self_id: 111111 },
		{ ...event(), user_id: 999999 },
		{ ...event(), anonymous: { id: 1 } },
		{ ...event(), time: now / 1000 - 121 },
		{ ...event(), time: now / 1000 + 121 },
		{ ...event(), message: [{ type: 'forward', data: { id: '1' } }, ...event().message] },
		{ ...event(), message: [{ type: 'at', data: { qq: '111111' } }, ...event().message] },
		{ ...event(), message: '[CQ:at,qq=999999]/签到' }
	])
		await bot.receive(request(modified));
	await bot.pump();
	expect(calls).toBe(0);
});

test('normal group conversation ignored; @bot and full-width slash understood', () => {
	expect(parseMessage(event('签到'), config.selfId, now)).toBeNull();
	expect(
		parseMessage(
			{
				...event('签到'),
				message: [
					{ type: 'at', data: { qq: '999999' } },
					{ type: 'text', data: { text: ' 签到 ' } }
				]
			},
			config.selfId,
			now
		)?.text
	).toBe('/签到');
	expect(parseMessage(event('／签到'), config.selfId, now)?.text).toBe('/签到');
	expect(
		parseMessage(
			{
				...event('/确认 123456'),
				message: [{ type: 'reply', data: { id: '1' } }, ...event('/确认 123456').message]
			},
			config.selfId,
			now
		)?.text
	).toBe('/确认 123456');
});

test('rate limits persist and duplicates are acknowledged without consuming budget', async () => {
	const inbox = makeInbox();
	const bot = new NapCatBot(config, inbox, { handle: async () => 'ok' }, sender, () => now);
	for (let i = 0; i < 12; i++)
		expect((await bot.receive(request(event('/帮助', i)))).status).toBe(200);
	expect((await bot.receive(request(event('/帮助', 99)))).status).toBe(429);
	expect((await bot.receive(request(event('/帮助', 1)))).status).toBe(200);
});

test('oversized bodies are rejected before parsing or dispatch', async () => {
	const bot = new NapCatBot(config, makeInbox(), { handle: async () => 'bad' }, sender, () => now);
	const payload = event('x'.repeat(70000));
	expect((await bot.receive(request(payload))).status).toBe(413);
});

test('uncertain reply delivery is retained, never replays command or auto-sends twice', async () => {
	let calls = 0,
		sends = 0;
	const inbox = makeInbox();
	const bot = new NapCatBot(
		config,
		inbox,
		{
			handle: async () => {
				calls++;
				return 'done';
			}
		},
		(async () => {
			sends++;
			throw new Error('timeout after send');
		}) as Fetcher,
		() => now
	);
	await bot.receive(request(event()));
	await bot.pump();
	await bot.pump();
	inbox.recover();
	await bot.pump();
	expect({ calls, sends }).toEqual({ calls: 1, sends: 1 });
	expect(inbox.stats().reply_unknown).toBe(1);
});

test('restart does not replay a command already claimed; pending payload is wiped on recovery', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'warcon-inbox-'));
	dirs.push(dir);
	const path = join(dir, 'bot.sqlite');
	const before = new Inbox(path);
	const message = parseMessage(event('/验证 123456'), config.selfId, now)!;
	before.accept('key', message, now);
	before.claim();
	before.close();
	const after = makeInbox(path);
	after.recover();
	expect(after.claim()).toBeNull();
	const reply = after.claimReply();
	expect(reply?.payload).toBe('');
	expect(reply?.reply).toContain('中断');
	after.recover();
	expect(after.stats().reply_unknown).toBe(1);
});

describe('signed NapCat → command engine → SQLite → game port', () => {
	test('bind, sign in twice, pay to change team, and replay callback safely', async () => {
		const store = new BotStore(':memory:');
		resources.push(store);
		const inbox = makeInbox();
		let moves = 0;
		const steamId = '76561198000000001';
		const warcon: WarconPort = {
			snapshot: async () => ({
				map: 'bakurani',
				playerCount: 1,
				maxPlayers: 100,
				scores: [
					{ name: 'Blue', score: 10 },
					{ name: 'Red', score: 20 }
				],
				players: [{ steamId, name: '玩家', faction: 'Red', kills: 1, deaths: 1, ping: 10 }],
				observedAt: now,
				canMove: true
			}),
			whisper: async (_s, _id, message) => {
				expect(message).toContain('123456');
			},
			move: async (_s, id, faction) => {
				expect(id).toBe(steamId);
				expect(faction).toBe('Blue');
				moves++;
			},
			reserved: async () => ({ state: 'none', expiresAt: null })
		};
		const group = { ...groups[0], checkinPoints: 30 };
		const bot = new NapCatBot(
			{ ...config, groups: [group] },
			inbox,
			new CommandHandler(store, warcon, { now: () => now, code: () => '123456' }),
			sender,
			() => now
		);
		const texts = ['/绑定 ' + steamId, '/验证 123456', '/签到', '/签到', '/换边蓝', '/确认 123456'];
		for (let i = 0; i < texts.length; i++) {
			await bot.receive(request(event(texts[i], i)));
			await bot.pump();
		}
		await bot.receive(request(event(texts[5], 5)));
		await bot.pump();
		expect(moves).toBe(1);
		expect(store.balance(group.communityId, '123457')).toBe(10);
	});
});

test('queued confirmations cannot execute after configuration revision changes; a new callback can', async () => {
	const store = new BotStore(':memory:');
	resources.push(store);
	const inbox = makeInbox();
	const steamId = '76561198000000001';
	const group = { ...groups[0], checkinPoints: 30 };
	const liveConfig = { ...config, groups: [group], revision: 'before-edit' };
	store.beginBinding(group.communityId, '123457', steamId, '123456', now);
	const binding = store.verifyBinding(group.communityId, '123457', '123456', now);
	store.checkin(group.communityId, '123457', '2026-10-23', 30, now);
	store.prepareMove(binding, group.serverId, 'Blue', 20, '234567', now);
	let reads = 0;
	const moves: string[] = [];
	const warcon: WarconPort = {
		snapshot: async () => {
			reads++;
			return {
				map: 'bakurani',
				playerCount: 1,
				maxPlayers: 100,
				scores: [
					{ name: 'Blue', score: 10 },
					{ name: 'Red', score: 20 }
				],
				players: [{ steamId, name: '玩家', faction: 'Red', kills: 1, deaths: 1, ping: 10 }],
				observedAt: now,
				canMove: true
			};
		},
		whisper: async () => {
			throw new Error('This test must not whisper');
		},
		move: async (_serverId, player, faction) => {
			expect(player).toBe(steamId);
			moves.push(faction);
		},
		reserved: async () => ({ state: 'none', expiresAt: null })
	};
	const replies: string[] = [];
	const bot = new NapCatBot(
		liveConfig,
		inbox,
		new CommandHandler(store, warcon, { now: () => now }),
		(async (_input, init) => {
			replies.push(JSON.parse(String(init?.body)).message[1].data.text);
			return Response.json({ status: 'ok', retcode: 0, data: { message_id: replies.length } });
		}) as Fetcher,
		() => now
	);
	const oldMessage = event('/确认 234567', 500);
	expect((await bot.receive(request(oldMessage))).status).toBe(200);
	expect(inbox.stats()).toEqual({ pending: 1 });
	liveConfig.revision = 'after-edit';
	// Keep the quote intact to ensure this regression specifically tests the inbox revision guard.
	await bot.pump();
	expect(replies[0]).toContain('配置已更新');
	expect(reads).toBe(0);
	expect(moves).toEqual([]);
	expect(store.balance(group.communityId, '123457')).toBe(30);
	await bot.receive(request(oldMessage));
	await bot.pump();
	expect(moves).toEqual([]);
	expect(replies).toHaveLength(1);

	// A newly authenticated callback is stamped with the current revision and may execute.
	await bot.receive(request(event('/确认 234567', 501)));
	await bot.pump();
	expect(replies[1]).toContain('成功执行');
	expect(reads).toBe(1);
	expect(moves).toEqual(['Blue']);
	expect(store.balance(group.communityId, '123457')).toBe(10);
});
