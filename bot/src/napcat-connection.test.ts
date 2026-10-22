import { afterEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { NapCatConnection } from './napcat-connection';
import { NapCatBot, type Fetcher } from './napcat';
import { Inbox } from './inbox';
import { parseGroups, type BotConfig } from './config';

const resources: Inbox[] = [];
afterEach(() => resources.splice(0).forEach((r) => r.close()));

function fixture() {
	let now = 1792700000000;
	const config: BotConfig = {
		host: '127.0.0.1',
		port: 3100,
		databasePath: ':memory:',
		selfId: '888888',
		autoSelfId: true,
		webhookSecret: 'test-webhook-secret-at-least24',
		napcatUrl: 'http://napcat.test',
		napcatToken: 'private-token',
		warconUrl: '',
		warconToken: '',
		revision: 'initial',
		groups: parseGroups([
			{
				groupId: '123456',
				communityId: 'test',
				serverId: 's1',
				serverName: '测试服',
				factions: { 蓝: 'Blue', 红: 'Red', 绿: 'Green' }
			}
		])
	};
	const api = {
		selfId: '999999',
		online: true,
		calls: [] as string[],
		sent: [] as string[],
		fail: ''
	};
	const fetcher: Fetcher = async (input, init) => {
		const action = String(input).split('/').pop()!;
		api.calls.push(action);
		expect(init?.redirect).toBe('error');
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-token');
		if (api.fail === 'network') throw new Error('private-token must not leak');
		if (api.fail === 'auth') return new Response('private-token', { status: 401 });
		if (api.fail === 'html') return new Response('<html>error</html>');
		if (api.fail === 'oversized') return new Response(' '.repeat(65537));
		if (api.fail === 'shape') return Response.json({ status: 'ok', retcode: 0, data: [] });
		if (api.fail === 'offline-string')
			return Response.json({ status: 'ok', retcode: 0, data: { online: 'true', good: true } });
		if (action === 'send_group_msg') {
			api.sent.push(String(init?.body));
			return Response.json({ status: 'ok', retcode: 0, data: { message_id: 1 } });
		}
		return Response.json({
			status: 'ok',
			retcode: 0,
			data:
				action === 'get_status'
					? { online: api.online, good: true }
					: { user_id: api.selfId, nickname: '当前机器人' }
		});
	};
	const inbox = new Inbox(':memory:');
	resources.push(inbox);
	let changes = 0;
	const connection = new NapCatConnection(
		config,
		() => {
			changes++;
			inbox.discardSession();
		},
		fetcher,
		() => now
	);
	const request = (id = 1, selfId = api.selfId, signed = true, groupId = 123456, meta = false) => {
		const body = JSON.stringify({
			self_id: Number(selfId),
			post_type: meta ? 'meta_event' : 'message',
			message_type: 'group',
			sub_type: 'normal',
			user_id: 123457,
			group_id: groupId,
			message_id: id,
			time: now / 1000,
			message: [{ type: 'text', data: { text: '/帮助' } }]
		});
		return new Request('http://bot.test/onebot/events', {
			method: 'POST',
			body,
			headers: {
				'x-self-id': selfId,
				'x-signature':
					'sha1=' +
					(signed
						? createHmac('sha1', config.webhookSecret).update(body).digest('hex')
						: '0'.repeat(40))
			}
		});
	};
	return {
		config,
		api,
		fetcher,
		inbox,
		connection,
		request,
		changes: () => changes,
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		}
	};
}

test('discovers trusted QQ, caches/single-flights polling, follows account change and reconnects', async () => {
	const f = fixture();
	expect(f.config.selfId).toBe('');
	await Promise.all([f.connection.refresh(), f.connection.refresh(), f.connection.refresh()]);
	expect(f.api.calls).toEqual(['get_status', 'get_login_info']);
	expect(f.config.selfId).toBe('999999');
	expect(f.connection.status()).toMatchObject({
		online: true,
		selfId: '999999',
		checkedAt: f.now()
	});
	const first = f.config.revision;
	await f.connection.refresh();
	expect(f.api.calls).toHaveLength(2);
	f.api.selfId = '777777';
	f.advance(5000);
	await f.connection.refresh();
	expect(f.config.selfId).toBe('777777');
	expect(f.config.revision).not.toBe(first);
	const second = f.config.revision;
	await f.connection.refresh(true);
	expect(f.config.revision).toBe(second);
	f.api.online = false;
	await f.connection.refresh(true);
	expect(f.config.selfId).toBe('');
	expect(f.connection.status().online).toBe(false);
	const offline = f.config.revision;
	await f.connection.refresh(true);
	expect(f.config.revision).toBe(offline);
	f.api.online = true;
	await f.connection.refresh(true);
	expect(f.config.selfId).toBe('777777');
	expect(f.config.revision).not.toBe(offline);
	expect(f.changes()).toBe(4);
});

test('network/auth/malformed responses and invalid account IDs suspend execution without leaking details', async () => {
	for (const fail of ['network', 'auth', 'html', 'oversized', 'shape', 'offline-string']) {
		const f = fixture();
		await f.connection.refresh();
		f.api.fail = fail;
		await f.connection.refresh(true);
		expect(f.config.selfId).toBe('');
		expect(f.connection.status().online).toBe(false);
		expect(JSON.stringify(f.connection.status())).not.toContain('private-token');
	}
	const f = fixture();
	f.api.selfId = 'invalid';
	await f.connection.refresh();
	expect(f.config.selfId).toBe('');
	expect(f.connection.status().online).toBe(false);
});

test('unsigned or forged account callbacks cannot choose identity; valid new-account callbacks trigger discovery', async () => {
	const f = fixture();
	let handled = 0;
	const bot = new NapCatBot(
		f.config,
		f.inbox,
		{
			handle: async () => {
				handled++;
				return '帮助';
			}
		},
		f.fetcher,
		f.now,
		f.connection
	);
	expect((await bot.receive(f.request(1, '777777', false))).status).toBe(401);
	expect(f.api.calls).toHaveLength(0);
	expect((await bot.receive(f.request(1, '777777'))).status).toBe(401);
	expect(f.config.selfId).toBe('999999');
	f.api.selfId = '777777';
	expect((await bot.receive(f.request())).status).toBe(200);
	expect(f.config.selfId).toBe('777777');
	expect(f.connection.status().lastEventAt).toBe(f.now());
	await bot.pump();
	expect(handled).toBe(1);
	expect(f.api.sent).toHaveLength(1);
	await bot.receive(f.request(2, '777777', true, 654321));
	await bot.pump();
	expect(handled).toBe(1);
});

test('queued commands and replies are discarded on switch, and new-account commands still work', async () => {
	const f = fixture();
	let handled = 0;
	const bot = new NapCatBot(
		f.config,
		f.inbox,
		{
			handle: async () => {
				handled++;
				return '帮助';
			}
		},
		f.fetcher,
		f.now,
		f.connection
	);
	await bot.receive(f.request(1));
	await bot.receive(f.request(2));
	const row = f.inbox.claim()!;
	f.inbox.finish(row.key, '旧账号回复');
	f.api.selfId = '777777';
	// No clock advance: execution must refresh even inside the ordinary polling cache window.
	await bot.pump();
	expect(handled).toBe(0);
	expect(f.api.sent).toHaveLength(0);
	expect(f.inbox.stats()).toEqual({ discarded: 2 });
	await bot.receive(f.request(3));
	await bot.pump();
	expect(handled).toBe(1);
	expect(f.api.sent).toHaveLength(1);
	expect(f.inbox.stats()).toEqual({ discarded: 2, sent: 1 });
});

test('account switch during an in-flight command prevents its reply and invalidates its revision', async () => {
	const f = fixture();
	let finish!: () => void, started!: () => void;
	const began = new Promise<void>((r) => {
		started = r;
	});
	const pending = new Promise<void>((r) => {
		finish = r;
	});
	let handled = 0;
	const bot = new NapCatBot(
		f.config,
		f.inbox,
		{
			handle: async (message) => {
				handled++;
				const revision = message.configurationRevision;
				started();
				await pending;
				expect(f.config.revision).not.toBe(revision);
				return '旧结果';
			}
		},
		f.fetcher,
		f.now,
		f.connection
	);
	await bot.receive(f.request());
	const pump = bot.pump();
	await began;
	f.api.selfId = '777777';
	await f.connection.refresh(true);
	finish();
	await pump;
	expect(f.inbox.stats()).toEqual({ discarded: 1 });
	expect(handled).toBe(1);
	expect(f.api.sent).toHaveLength(0);
});

test('offline callbacks fail, reconnect succeeds, and signed heartbeats verify reporting without replying', async () => {
	const f = fixture();
	const bot = new NapCatBot(
		f.config,
		f.inbox,
		{ handle: async () => '帮助' },
		f.fetcher,
		f.now,
		f.connection
	);
	f.api.online = false;
	expect((await bot.receive(f.request())).status).toBe(503);
	expect(f.connection.status().lastEventAt).toBeNull();
	f.api.online = true;
	expect((await bot.receive(f.request(2, f.api.selfId, true, 123456, true))).status).toBe(200);
	expect(f.connection.status().lastEventAt).toBe(f.now());
	await bot.pump();
	expect(f.api.sent).toHaveLength(0);
	expect(f.inbox.stats()).toEqual({});
	const count = f.api.calls.length;
	await bot.pump();
	await bot.pump();
	expect(f.api.calls).toHaveLength(count);
});
