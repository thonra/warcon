import { afterEach, expect, spyOn, test } from 'bun:test';
import { QQBot, type QQBotInboundMessage, type QQBotOptions } from '@tencent-connect/qqbot-nodejs';
import { OfficialBot, officialMessage, type OfficialClient } from './official';
import { Inbox } from './inbox';
import type { ReplyOverrides } from './reply-copy';
import { NapCatBot } from './napcat';
import type { BotConfig } from './config';
import type { BotMessage, GroupConfig } from './contracts';
import { BotStore } from './store';
import { CommandHandler } from './commands';

const APP = '1234567890';
const GROUP = 'ABCDEF123456';
const USER = 'DEADBEEF123456';
const NOW = Date.now();
const group: GroupConfig = {
	groupId: '1127697668',
	communityId: 'wardogs',
	serverId: 'alpha',
	serverName: '余烬',
	timezone: 'Asia/Shanghai',
	checkinPoints: 10,
	moveCost: 5,
	moveCooldownSeconds: 300,
	factions: { 蓝: 'Blue', 红: 'Red', 绿: 'Green' },
	officialAppId: APP,
	officialGroupId: GROUP
};
const config = (): BotConfig => ({
	host: '127.0.0.1',
	port: 3100,
	databasePath: ':memory:',
	selfId: '12345',
	napcatUrl: 'http://unused',
	napcatToken: 'test',
	webhookSecret: 'test',
	warconUrl: '',
	warconToken: '',
	groups: [{ ...group }],
	revision: 'v1'
});
const raw = (extra: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage => ({
	kind: 'group',
	rawEventType: 'GROUP_AT_MESSAGE_CREATE',
	senderId: USER,
	groupOpenid: GROUP,
	content: ' /帮助',
	messageId: 'ROBOT1.0_test!',
	timestamp: new Date(NOW).toISOString(),
	replyTarget: { scope: 'group', targetId: GROUP },
	raw: {} as QQBotInboundMessage['raw'],
	...extra
});
const cleanup: (() => void)[] = [];
afterEach(() =>
	cleanup
		.splice(0)
		.reverse()
		.forEach((f) => f())
);
class FakeClient {
	handlers = new Map<string, ((...args: any[]) => unknown)[]>();
	posts: unknown[][] = [];
	stops = 0;
	finish!: () => void;
	result: unknown = { id: 'sent' };
	tokenManager = { getAccessToken: async () => 'fake-token' };
	apiClient = {
		request: async (...args: unknown[]) => {
			this.posts.push(args);
			return this.result;
		}
	};
	on(event: string, cb: (...args: any[]) => unknown) {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
		return this;
	}
	emit(event: string, ...args: unknown[]) {
		return Promise.all((this.handlers.get(event) ?? []).map((cb) => cb(...args)));
	}
	start() {
		return new Promise<void>((done) => {
			this.finish = done;
		});
	}
	stop() {
		this.stops++;
		this.finish?.();
	}
}
function fixture(
	handle?: (m: BotMessage, g: GroupConfig) => Promise<string>,
	replies: () => ReplyOverrides = () => ({})
) {
	const c = config();
	const inbox = new Inbox(':memory:');
	const clients: FakeClient[] = [];
	const calls: BotMessage[] = [];
	const options: QQBotOptions[] = [];
	let now = NOW;
	const bot = new OfficialBot(
		c,
		inbox,
		{
			handle: async (m, g) => {
				calls.push(m);
				return handle ? handle(m, g) : '服务正常';
			}
		},
		(o) => {
			options.push(o);
			const f = new FakeClient();
			clients.push(f);
			return f as unknown as OfficialClient;
		},
		() => now,
		replies
	);
	cleanup.push(() => {
		bot.stop();
		inbox.close();
	});
	bot.configure({ provider: 'official', appId: APP, appSecret: 'synthetic-secret' });
	const client = clients[0];
	void client.emit('ready', { user: { id: 'bot-user', username: '助手' } });
	return {
		c,
		inbox,
		bot,
		client,
		clients,
		calls,
		options,
		advance: (ms: number) => {
			now += ms;
		}
	};
}

test('official parser scopes member identity by app and group and ignores unrelated content', () => {
	expect(officialMessage(raw({ content: '<@12345> ／换边 蓝' }), APP, NOW)).toMatchObject({
		text: '/换边 蓝',
		userId: `qqofficial:${APP}:${GROUP}:${USER}`
	});
	for (const override of [
		{ kind: 'c2c' },
		{ senderIsBot: true },
		{ timestamp: 'invalid' },
		{ timestamp: new Date(NOW - 120001).toISOString() },
		{ senderId: '../123' },
		{ groupOpenid: '' },
		{ messageId: '' },
		{ attachments: [{}] },
		{ rawEventType: 'GROUP_MESSAGE_CREATE', content: '' },
		{ content: 'a'.repeat(301) },
		{ rawEventType: 'GROUP_MESSAGE_CREATE', content: '换边 蓝' }
	])
		expect(officialMessage(raw(override as Partial<QQBotInboundMessage>), APP, NOW)).toBeNull();
	expect(
		officialMessage(raw({ content: '谢谢', msgElements: [{ content: '/换边 蓝' }] }), APP, NOW)
			?.text
	).toBe('/谢谢');
	expect(
		officialMessage(raw({ rawEventType: 'GROUP_MESSAGE_CREATE', content: '/帮助' }), APP, NOW)?.text
	).toBe('/帮助');
});
test('a bare group mention opens help without interpreting quoted, private or media content', () => {
	for (const content of ['', ' ', '<@12345>', ' <@!12345> '])
		expect(officialMessage(raw({ content }), APP, NOW)?.text).toBe('/帮助');
	for (const extra of [
		{ rawEventType: 'GROUP_MESSAGE_CREATE', content: '' },
		{ content: '', msgType: 103, msgElements: [{ content: '/换边 蓝' }] },
		{ content: '', msgType: 3 },
		{ content: '', attachments: [{}] },
		{ kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', content: '' }
	])
		expect(officialMessage(raw(extra as Partial<QQBotInboundMessage>), APP, NOW)).toBeNull();
});
test('bare mentions discover an unmapped group and reply only after explicit group authorization', async () => {
	const f = fixture(async (m) => m.text);
	f.c.groups = [];
	await f.client.emit('message', {}, raw({ content: '' }));
	expect(f.bot.status().groups).toEqual([{ openid: GROUP, lastSeenAt: NOW }]);
	await f.bot.pump();
	expect(f.calls).toHaveLength(0);
	expect(f.client.posts).toHaveLength(0);
	f.c.groups = [{ ...group }];
	await f.client.emit('message', {}, raw({ content: '', messageId: 'authorized-bare-mention' }));
	await f.bot.pump();
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0].text).toBe('/帮助');
	expect(f.client.posts).toHaveLength(1);
	expect(f.client.posts[0][3]).toMatchObject({
		content: '/帮助',
		msg_id: 'authorized-bare-mention'
	});
});
test('receive diagnostics distinguish filtering and mapping and never expose SDK log contents', async () => {
	const f = fixture();
	const logs = spyOn(console, 'warn').mockImplementation(() => {});
	cleanup.push(() => logs.mockRestore());
	await f.client.emit(
		'message',
		{},
		raw({
			content: '',
			attachments: [{ content_type: 'image/jpeg', url: 'https://example.invalid/image.jpg' }]
		})
	);
	f.c.groups = [];
	await f.client.emit('message', {}, raw());
	expect(f.bot.status()).toMatchObject({
		receivedMessages: 2,
		filteredMessages: 1,
		unmappedMessages: 1,
		lastReceivedAt: NOW
	});
	f.options[0].logger?.error?.('Message parse error: secret-response-body /绑定 private-code');
	expect(f.bot.status()).toMatchObject({
		sdkErrors: 1,
		lastSdkError: '官方消息解析失败，请检查接收记录。'
	});
	expect(JSON.stringify(logs.mock.calls)).not.toContain('secret-response-body');
	expect(JSON.stringify(logs.mock.calls)).not.toContain('private-code');
	await f.client.emit('disconnected');
	f.bot.reconnect();
	f.options[0].logger?.error?.('retired client error');
	await f.client.emit('message', {}, raw());
	expect(f.bot.status().receivedMessages).toBe(2);
	expect(f.bot.status().sdkErrors).toBe(1);
});
test('official SDK configuration uses documented endpoints and minimum event subscription', () => {
	const f = fixture();
	expect(f.options[0]).toMatchObject({
		baseUrl: 'https://api.bot.qq.com',
		tokenBaseUrl: 'https://api.bot.qq.com',
		intents: 1 << 25,
		transport: 'websocket',
		markdownSupport: false
	});
	expect(f.options[0].logger?.debug).toBeUndefined();
});
test('authenticated group discovery does not grant command access; explicit mapping is required', async () => {
	const f = fixture();
	f.c.groups = [];
	await f.client.emit('message', {}, raw());
	await f.bot.pump();
	expect(f.bot.status().groups).toEqual([{ openid: GROUP, lastSeenAt: NOW }]);
	expect(f.calls).toHaveLength(0);
	expect(f.client.posts).toHaveLength(0);
	f.c.groups = [{ ...group, officialAppId: '9999999999' }];
	await f.client.emit('message', {}, raw());
	await f.bot.pump();
	expect(f.calls).toHaveLength(0);
	f.c.groups = [group];
	await f.client.emit('message', {}, raw());
	await f.bot.pump();
	expect(f.calls).toHaveLength(1);
});
test('one event executes and replies once, with original msg_id and seq; secrets/codes are cleared from inbox', async () => {
	const f = fixture();
	await f.client.emit('message', {}, raw({ content: '/验证 654321' }));
	await f.client.emit('message', {}, raw({ content: '/验证 654321' }));
	await f.bot.pump();
	await f.bot.pump();
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0].groupId).toBe(group.groupId);
	expect(f.client.posts).toHaveLength(1);
	expect(f.client.posts[0][2]).toBe(`/v2/groups/${GROUP}/messages`);
	expect(f.client.posts[0][3]).toMatchObject({
		content: '服务正常',
		msg_id: 'ROBOT1.0_test!',
		msg_seq: 1,
		msg_type: 0
	});
	expect(f.inbox.stats()).toEqual({ sent: 1 });
});
test('body-level API errors and ambiguous replies are not success and never rerun commands', async () => {
	const f = fixture();
	f.client.result = { id: 'misleading', err_code: 40034005, message: 'private content' };
	await f.client.emit('message', {}, raw());
	await f.bot.pump();
	await f.bot.pump();
	expect(f.inbox.stats()).toEqual({ reply_unknown: 1 });
	expect(f.calls).toHaveLength(1);
	expect(f.bot.status().lastReplyError).toContain('40034005');
	expect(JSON.stringify(f.bot.status())).not.toContain('private content');
});
test('switching provider during a command prevents stale replies and late official callbacks', async () => {
	let finish!: (value: string) => void;
	const f = fixture(
		() =>
			new Promise((done) => {
				finish = done;
			})
	);
	await f.client.emit('message', {}, raw());
	const work = f.bot.pump();
	f.c.revision = 'v2';
	f.inbox.discardSession();
	f.bot.configure({ provider: 'napcat', appId: APP, appSecret: 'synthetic-secret' });
	await f.client.emit('message', {}, raw({ messageId: 'late' }));
	finish('done');
	await work;
	expect(f.calls).toHaveLength(1);
	expect(f.client.posts).toHaveLength(0);
	expect(f.inbox.stats()).toEqual({ discarded: 1 });
	expect(f.bot.status().phase).toBe('standby');
});
test('configuration change while awaiting reply token cannot send old reply', async () => {
	const f = fixture();
	let finish!: (token: string) => void;
	f.client.tokenManager.getAccessToken = () =>
		new Promise((done) => {
			finish = done;
		});
	await f.client.emit('message', {}, raw());
	const work = f.bot.pump();
	while (!finish) await Promise.resolve();
	f.c.revision = 'changed';
	finish('token');
	await work;
	expect(f.client.posts).toHaveLength(0);
	expect(f.inbox.stats()).toEqual({ reply_unknown: 1 });
});
test('expired queued commands do not execute or attempt expired replies', async () => {
	const f = fixture();
	await f.client.emit('message', {}, raw());
	f.advance(120001);
	await f.bot.pump();
	expect(f.calls).toHaveLength(0);
	expect(f.client.posts).toHaveLength(0);
});
test('unconfigured official mode does not start a connection', () => {
	const f = fixture();
	f.bot.configure({ provider: 'official', appId: '', appSecret: '' });
	f.bot.tick();
	expect(f.clients).toHaveLength(1);
	expect(f.bot.status()).toMatchObject({ online: false, phase: 'unconfigured' });
});
test('inactive NapCat acknowledges callbacks without calling its API or claiming official work', async () => {
	const f = fixture();
	let requests = 0;
	const napcat = new NapCatBot(
		f.c,
		f.inbox,
		{
			handle: async () => {
				throw new Error('must not run');
			}
		},
		async () => {
			requests++;
			throw new Error('must not call');
		},
		() => NOW,
		undefined,
		() => false
	);
	await f.client.emit('message', {}, raw());
	expect(
		(
			await napcat.receive(
				new Request('http://localhost/onebot/events', { method: 'POST', body: '{}' })
			)
		).status
	).toBe(200);
	await napcat.pump();
	expect(requests).toBe(0);
	expect(f.inbox.stats()).toEqual({ pending: 1 });
	await f.bot.pump();
	expect(f.calls).toHaveLength(1);
});
test.each([`qqofficial:${APP}:${GROUP}:${USER}`, `qqofficial:c2c:${APP}:${USER}`])(
	'official re-verification preserves existing points and daily limits: %s',
	async (identity) => {
		const store = new BotStore(':memory:');
		cleanup.push(() => store.close());
		const steam = '76561198000000001';
		store.beginBinding(group.communityId, '12345', steam, '123456', NOW);
		store.verifyBinding(group.communityId, '12345', '123456', NOW);
		store.checkin(group.communityId, '12345', '2026-10-23', 10, NOW);
		store.beginBinding(group.communityId, identity, steam, '654321', NOW);
		expect(() => store.verifyBinding(group.communityId, identity, 'bad', NOW)).toThrow(
			'验证码不正确'
		);
		expect(store.accountUserId(group.communityId, identity)).toBe(identity);
		expect(store.verifyBinding(group.communityId, identity, '654321', NOW).userId).toBe('12345');
		expect(store.binding(group.communityId, '12345')?.steamId).toBe(steam);
		expect(store.balance(group.communityId, store.accountUserId(group.communityId, identity))).toBe(
			10
		);
		expect(
			store.checkin(
				group.communityId,
				store.accountUserId(group.communityId, identity),
				'2026-10-23',
				10,
				NOW
			).added
		).toBe(false);
		expect(store.accountUserId('other-community', identity)).toBe(identity);
		expect(() => store.beginBinding(group.communityId, '67890', steam, '000000', NOW)).toThrow(
			'已被绑定'
		);
		const handler = new CommandHandler(store, {
			reserved: async () => ({ state: 'none', expiresAt: null })
		} as never);
		expect(
			await handler.handle(
				{ id: 'points', groupId: group.groupId, userId: identity, text: '/积分', time: NOW },
				group
			)
		).toContain('积分余额：10');
	}
);
test('cancelling removes only own pending requests and never refunds an existing operation', () => {
	const store = new BotStore(':memory:');
	cleanup.push(() => store.close());
	const community = group.communityId;
	store.beginBinding(community, '12345', '76561198000000001', '111111', NOW);
	expect(store.cancelPending(community, '67890', group.serverId)).toBe(0);
	expect(store.cancelPending(community, '12345', group.serverId)).toBe(1);
	expect(() => store.verifyBinding(community, '12345', '111111', NOW)).toThrow('已过期');
});

// Exercise the actual pinned Tencent SDK over local HTTP + WS rather than mocking its event API.
test.each(['group', 'c2c'] as const)(
	'real Tencent SDK exchanges token, receives %s and sends documented REST reply',
	async (kind) => {
		const route = kind === 'group' ? `/v2/groups/${GROUP}/messages` : `/v2/users/${USER}/messages`;
		let socket: any;
		const posts: any[] = [];
		const tokenBodies: any[] = [];
		const identifies: any[] = [];
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: async (request, server) => {
				const path = new URL(request.url).pathname;
				if (path === '/ws') {
					if (server.upgrade(request)) return;
					return new Response('', { status: 400 });
				}
				if (path === '/app/getAppAccessToken') {
					tokenBodies.push(await request.json());
					return Response.json({ access_token: 'synthetic-access-token', expires_in: '7200' });
				}
				if (path === '/gateway') return Response.json({ url: `ws://127.0.0.1:${server.port}/ws` });
				if (path === route) {
					posts.push({
						authorization: request.headers.get('authorization'),
						body: await request.json()
					});
					return Response.json({ id: 'reply-id' });
				}
				return new Response('', { status: 404 });
			},
			websocket: {
				open(ws) {
					socket = ws;
					ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
				},
				message(ws, data) {
					const p = JSON.parse(String(data));
					if (p.op === 2) {
						identifies.push(p);
						ws.send(
							JSON.stringify({
								op: 0,
								s: 1,
								t: 'READY',
								d: { session_id: 'synthetic-session', user: { id: '12345', username: 'test' } }
							})
						);
					}
					if (p.op === 1) ws.send(JSON.stringify({ op: 11 }));
				}
			}
		});
		const c = config();
		const inbox = new Inbox(':memory:');
		let calls = 0;
		const bot = new OfficialBot(
			c,
			inbox,
			{
				handle: async (message) => {
					expect(message.text).toBe('/帮助');
					calls++;
					return '官方接入正常';
				}
			},
			(options) =>
				new QQBot({
					...options,
					baseUrl: `http://127.0.0.1:${server.port}`,
					tokenBaseUrl: `http://127.0.0.1:${server.port}`
				})
		);
		try {
			bot.configure({
				provider: 'official',
				appId: APP,
				appSecret: 'synthetic-secret',
				privateTests: [{ appId: APP, userOpenid: USER, groupId: group.groupId }]
			});
			await until(() => bot.status().online);
			socket.send(
				JSON.stringify({
					op: 0,
					s: 2,
					t: 'GROUP_ADD_ROBOT',
					d: { group_openid: GROUP, timestamp: Math.floor(Date.now() / 1000) }
				})
			);
			await until(() => bot.status().groupEvents.length === 1);
			expect(calls).toBe(0);
			const event = {
				op: 0,
				s: 2,
				t: kind === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE',
				d: {
					id: 'platform-message-id',
					content: kind === 'group' ? '' : ' /帮助',
					timestamp: new Date().toISOString(),
					group_openid: GROUP,
					author: { member_openid: USER, user_openid: USER }
				}
			};
			socket.send(JSON.stringify(event));
			await until(() => inbox.hasWork('pending'));
			await bot.pump();
			expect(tokenBodies[0]).toEqual({ appId: APP, clientSecret: 'synthetic-secret' });
			expect(identifies[0].d).toMatchObject({
				token: 'QQBot synthetic-access-token',
				intents: 1 << 25
			});
			expect(calls).toBe(1);
			expect(posts).toMatchObject([
				{
					authorization: 'QQBot synthetic-access-token',
					body: {
						msg_type: 0,
						content: kind === 'group' ? '官方接入正常' : '余烬 · 私聊测试\n官方接入正常',
						msg_id: 'platform-message-id',
						msg_seq: 1
					}
				}
			]);
		} finally {
			bot.stop();
			await server.stop(true);
			inbox.close();
		}
	}
);
async function until(condition: () => boolean) {
	const deadline = Date.now() + 2500;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('condition timed out');
		await Bun.sleep(5);
	}
}

test('command buttons are actor-scoped and confirmation is a sendable command, never a direct effect', async () => {
	const f = fixture(async () => '如确认，请在2分钟内发送 /确认 123456；不回复即取消');
	await f.client.emit('message', {}, raw());
	await f.bot.pump();
	const body = f.client.posts[0][3] as any;
	expect(body.keyboard.content.rows[0].buttons[0].action).toEqual({
		type: 2,
		permission: { type: 0, specify_user_ids: [USER] },
		data: '/确认 123456',
		enter: false
	});
	expect(body.content).toBe('如确认，请在2分钟内发送 /确认 123456；不回复即取消');
});
test('definite keyboard refusal falls back to text without re-executing; timeout never falls back', async () => {
	const f = fixture();
	f.client.apiClient.request = async (...args: unknown[]) => {
		f.client.posts.push(args);
		if ((args[3] as any).keyboard) throw { bizCode: 304037 };
		return { id: 'sent' };
	};
	await f.client.emit('message', {}, raw());
	await f.bot.pump();
	expect(f.calls).toHaveLength(1);
	expect(f.client.posts).toHaveLength(2);
	expect((f.client.posts[1][3] as any).keyboard).toBeUndefined();
	expect(f.bot.status().buttonsAvailable).toBe(false);
	expect(f.inbox.stats()).toEqual({ sent: 1 });
	const g = fixture();
	g.client.apiClient.request = async (...args: unknown[]) => {
		g.client.posts.push(args);
		throw new Error('network timeout');
	};
	await g.client.emit('message', {}, raw());
	await g.bot.pump();
	expect(g.client.posts).toHaveLength(1);
	expect(g.inbox.stats()).toEqual({ reply_unknown: 1 });
});

const privateRaw = (extra: Partial<QQBotInboundMessage> = {}) =>
	raw({
		kind: 'c2c',
		rawEventType: 'C2C_MESSAGE_CREATE',
		groupOpenid: undefined,
		replyTarget: { scope: 'c2c', targetId: USER },
		...extra
	});
function enablePrivate(f: ReturnType<typeof fixture>) {
	f.bot.configure({
		provider: 'official',
		appId: APP,
		appSecret: 'synthetic-secret',
		privateTests: [{ appId: APP, userOpenid: USER, groupId: group.groupId }]
	});
	const client = f.clients.at(-1)!;
	void client.emit('ready', { user: { id: 'bot-user' } });
	return client;
}
test('C2C discovery cannot execute commands; only explicitly approved identity can use the selected policy', async () => {
	const f = fixture();
	await f.client.emit('message', {}, privateRaw());
	await f.bot.pump();
	expect(f.bot.status().privateUsers).toEqual([{ openid: USER, lastSeenAt: NOW }]);
	expect(f.bot.status().groups).toEqual([]);
	expect(f.calls).toHaveLength(0);
	expect(f.client.posts).toHaveLength(0);
	const client = enablePrivate(f);
	// Private tests do not depend on the bot having joined the real QQ group.
	f.c.groups = [{ ...group, officialAppId: undefined, officialGroupId: undefined }];
	await client.emit('message', {}, privateRaw({ senderId: 'UNAPPROVED' }));
	await client.emit('message', {}, privateRaw());
	await client.emit('message', {}, privateRaw());
	await f.bot.pump();
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0]).toMatchObject({
		groupId: group.groupId,
		userId: `qqofficial:c2c:${APP}:${USER}`
	});
	expect(client.posts).toHaveLength(1);
	expect(client.posts[0][2]).toBe(`/v2/users/${USER}/messages`);
	expect(client.posts[0][3]).toMatchObject({
		msg_id: 'ROBOT1.0_test!',
		msg_seq: 1,
		content: '余烬 · 私聊测试\n服务正常'
	});
	expect(
		(client.posts[0][3] as any).keyboard.content.rows[0].buttons[0].action.permission
			.specify_user_ids
	).toEqual([USER]);
});
test('C2C message indexes deduplicate delivery without replacing the original passive reply ID', async () => {
	const f = fixture();
	const client = enablePrivate(f);
	await client.emit(
		'message',
		{},
		privateRaw({ messageId: 'first-delivery', msgIdx: 'REFIDX_test==' })
	);
	await client.emit(
		'message',
		{},
		privateRaw({ messageId: 'redelivery', msgIdx: 'REFIDX_test==' })
	);
	await f.bot.pump();
	expect(f.calls).toHaveLength(1);
	expect(client.posts[0][3]).toMatchObject({ msg_id: 'first-delivery' });
});
test('C2C namespace is separate from group identities and rejects bots, attachments, cards and invalid indexes', () => {
	const message = officialMessage(privateRaw({ content: '／帮助' }), APP, NOW)!;
	expect(message.userId).toBe(`qqofficial:c2c:${APP}:${USER}`);
	expect(message.userId).not.toBe(officialMessage(raw({ groupOpenid: 'c2c' }), APP, NOW)?.userId);
	expect(message.text).toBe('/帮助');
	for (const extra of [
		{ rawEventType: 'DIRECT_MESSAGE_CREATE' },
		{ attachments: [{}] },
		{ msgType: 3 },
		{ msgType: 102 },
		{ msgIdx: 'a'.repeat(513) },
		{ raw: { author: { bot: true } } }
	])
		expect(officialMessage(privateRaw(extra as Partial<QQBotInboundMessage>), APP, NOW)).toBeNull();
	expect(
		officialMessage(
			privateRaw({ msgType: 103, content: '/积分', msgElements: [{ content: '/换边 蓝' }] }),
			APP,
			NOW
		)?.text
	).toBe('/积分');
});
test('revoking C2C access prevents queued commands and replies from running', async () => {
	const f = fixture();
	const client = enablePrivate(f);
	await client.emit('message', {}, privateRaw());
	f.bot.configure({
		provider: 'official',
		appId: APP,
		appSecret: 'synthetic-secret',
		privateTests: []
	});
	const latest = f.clients.at(-1)!;
	await latest.emit('ready', {});
	await f.bot.pump();
	expect(f.calls).toHaveLength(0);
	expect(latest.posts).toHaveLength(0);
});
test('revoking C2C while waiting for access token cannot send an authorized earlier reply', async () => {
	const f = fixture();
	const client = enablePrivate(f);
	let release!: (t: string) => void;
	client.tokenManager.getAccessToken = () =>
		new Promise<string>((r) => {
			release = r;
		});
	await client.emit('message', {}, privateRaw());
	const work = f.bot.pump();
	await until(() => !!release);
	f.bot.configure({
		provider: 'official',
		appId: APP,
		appSecret: 'synthetic-secret',
		privateTests: []
	});
	release('fake-token');
	await work;
	expect(f.calls).toHaveLength(1);
	expect(client.posts).toHaveLength(0);
});

test('group lifecycle notifications discover IDs without authorizing commands or recording raw payloads', async () => {
	const log = spyOn(console, 'info').mockImplementation(() => {});
	cleanup.push(() => log.mockRestore());
	const f = fixture();
	f.c.groups = [];
	await f.client.emit('rawEvent', {
		eventType: 'GROUP_ADD_ROBOT',
		data: { group_openid: GROUP, op_member_openid: 'private-operator', content: 'private-content' }
	});
	expect(f.bot.status().groupEvents).toEqual([
		{ event: 'GROUP_ADD_ROBOT', openid: GROUP, receivedAt: NOW }
	]);
	expect(f.bot.status().groups).toEqual([{ openid: GROUP, lastSeenAt: NOW }]);
	await f.client.emit('message', {}, raw());
	await f.bot.pump();
	expect(f.calls).toHaveLength(0);
	expect(f.client.posts).toHaveLength(0);
	expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
	await f.client.emit('rawEvent', { eventType: 'GROUP_DEL_ROBOT', data: { group_openid: GROUP } });
	expect(f.bot.status().groups).toEqual([]);
	expect(f.bot.status().groupEvents[0].event).toBe('GROUP_DEL_ROBOT');
});
test('group event history is bounded and ignores untrusted event types, malformed IDs and retired clients', async () => {
	const log = spyOn(console, 'info').mockImplementation(() => {});
	cleanup.push(() => log.mockRestore());
	const f = fixture();
	for (const payload of [
		{ eventType: 'GROUP_JOIN_REQUEST', data: { group_openid: GROUP } },
		{ eventType: 'GROUP_ADD_ROBOT', data: null },
		{ eventType: 'GROUP_ADD_ROBOT', data: { group_openid: '../bad' } }
	])
		await f.client.emit('rawEvent', payload);
	expect(f.bot.status().groupEvents).toEqual([]);
	expect(log).not.toHaveBeenCalled();
	for (let i = 0; i < 35; i++)
		await f.client.emit('rawEvent', {
			eventType: 'GROUP_MSG_RECEIVE',
			data: { group_openid: 'GROUP_' + i }
		});
	expect(f.bot.status().groupEvents).toHaveLength(30);
	f.bot.configure({ provider: 'official', appId: '9999999999', appSecret: 'synthetic' });
	await f.client.emit('rawEvent', { eventType: 'GROUP_ADD_ROBOT', data: { group_openid: GROUP } });
	expect(f.bot.status().groupEvents).toEqual([]);
	expect(f.bot.status().groups).toEqual([]);
});

test('editing reply presentation changes outgoing text on the existing connection', async () => {
	let overrides: ReplyOverrides = {};
	const f = fixture(
		async () => '正文',
		() => overrides
	);
	await f.client.emit('message', {}, raw());
	await f.bot.pump();
	expect((f.client.posts[0][3] as any).content).toBe('正文');
	overrides = { 'group.suffix': '新的附加文字' };
	await f.client.emit('message', {}, raw({ messageId: 'after-copy-edit' }));
	await f.bot.pump();
	expect((f.client.posts[1][3] as any).content).toBe('正文\n新的附加文字');
	expect(f.clients).toHaveLength(1);
	expect(f.c.revision).toBe('v1');
	expect(f.bot.status().online).toBe(true);
});
