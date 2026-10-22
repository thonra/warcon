import { afterEach, describe, expect, test } from 'bun:test';
import { CommandHandler } from './commands';
import { BotStore } from './store';
import {
	WarconError,
	type BotMessage,
	type GameSnapshot,
	type GroupConfig,
	type WarconPort
} from './contracts';

const STEAM = '76561198000000001';
const OTHER_STEAM = '76561198000000002';
const group: GroupConfig = {
	groupId: '100',
	communityId: 'community',
	serverId: 'server',
	serverName: '测试服',
	timezone: 'Asia/Shanghai',
	checkinPoints: 30,
	moveCost: 20,
	moveCooldownSeconds: 300,
	factions: { 蓝: 'Blue', 红: 'Red', 绿: 'Green' }
};
const stores: BotStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function fixture() {
	const store = new BotStore(':memory:');
	stores.push(store);
	let now = Date.parse('2026-10-23T12:00:00Z');
	let nonce = 111111;
	const whispers: { steamId: string; text: string }[] = [];
	const moves: { steamId: string; faction: string }[] = [];
	const snapshot: GameSnapshot = {
		map: 'Bakurani',
		playerCount: 2,
		maxPlayers: 100,
		scores: [
			{ name: 'Blue', score: 22 },
			{ name: 'Red', score: 21 },
			{ name: 'Green', score: 24 }
		],
		players: [
			{ steamId: STEAM, name: 'Alice', faction: 'Red', kills: 3, deaths: 1, ping: 60 },
			{ steamId: OTHER_STEAM, name: 'Bob', faction: 'Red', kills: 1, deaths: 3, ping: 70 }
		],
		observedAt: now,
		canMove: true
	};
	const api: WarconPort = {
		snapshot: async () => ({ ...snapshot, observedAt: now }),
		whisper: async (_, steamId, text) => {
			whispers.push({ steamId, text });
		},
		move: async (_, steamId, faction) => {
			moves.push({ steamId, faction });
		},
		reserved: async () => ({ state: 'none', expiresAt: null })
	};
	const handler = new CommandHandler(store, api, { now: () => now, code: () => String(nonce++) });
	let messageId = 0;
	const send = (text: string, userId = '200', config = group) =>
		handler.handle(
			{
				id: String(++messageId),
				groupId: config.groupId,
				userId,
				text,
				time: now
			} satisfies BotMessage,
			config
		);
	const bind = async (userId = '200', steamId = STEAM) => {
		await send(`/绑定 ${steamId}`, userId);
		const code = whispers.at(-1)!.text.match(/\/验证 ([0-9]{6})/)![1];
		expect(await send(`/验证 ${code}`, userId)).toContain('绑定成功');
	};
	const quote = async (userId = '200') => {
		const reply = await send('/换边蓝', userId);
		expect(reply).toContain('角色会重新部署');
		return reply.match(/\/确认 ([0-9]{6})/)![1];
	};
	return {
		store,
		api,
		snapshot,
		whispers,
		moves,
		send,
		bind,
		quote,
		time: () => now,
		setTime: (value: number) => {
			now = value;
		}
	};
}

describe('ownership and Chinese interaction', () => {
	test('binding requires an online account and in-game code; another actor cannot consume it', async () => {
		const f = fixture();
		expect(await f.send('/绑定 76561198000000003')).toContain('没有在服务器中找到');
		expect(f.whispers).toHaveLength(0);
		const reply = await f.send(`/绑定 ${STEAM}`);
		expect(reply).not.toContain('111111');
		expect(f.whispers[0].text).toContain('QQ账号 200');
		expect(await f.send('/验证 111111', '201')).toContain('不存在');
		expect(await f.send('/验证 111111')).toContain('绑定成功');
		expect(await f.send(`/绑定 ${OTHER_STEAM}`)).toContain('已经绑定');
		expect(await f.send(`/绑定 ${STEAM}`, '201')).toContain('已被绑定');
	});
	test('five wrong codes lock a challenge and application rate is limited', async () => {
		const f = fixture();
		await f.send(`/绑定 ${STEAM}`);
		expect(await f.send(`/绑定 ${STEAM}`)).toContain('每分钟最多');
		for (let attempt = 0; attempt < 5; attempt++)
			expect(await f.send('/验证 000000')).toContain('不正确');
		expect(await f.send('/验证 111111')).toContain('次数过多');
		expect(f.store.binding(group.communityId, '200')).toBeNull();
	});
	test('expired binding challenge cannot be used', async () => {
		const f = fixture();
		await f.send(`/绑定 ${STEAM}`);
		f.setTime(f.time() + 300_000);
		expect(await f.send('/验证 111111')).toContain('已过期');
	});
	test('help, current game, and reserved status have readable fallback', async () => {
		const f = fixture();
		expect(await f.send('/帮助')).toContain('/换边 蓝 / 红 / 绿');
		expect(await f.send('/帮助')).not.toContain('白名单');
		expect(await f.send('/查对局')).toContain('Bakurani');
		await f.bind();
		expect(await f.send('/查对局')).toContain('击杀 3 / 死亡 1');
		f.api.reserved = async () => ({ state: 'active', expiresAt: null });
		expect(await f.send('/积分')).toContain('未设置到期时间');
		f.api.reserved = async () => {
			throw new Error('secret-token');
		};
		expect(await f.send('/积分')).toContain('积分余额：0');
		expect(await f.send('/积分')).not.toContain('secret-token');
	});
});

describe('points and moves', () => {
	test('daily check-in is shared across community groups and changes at configured midnight', async () => {
		const f = fixture();
		await f.bind();
		f.setTime(Date.parse('2026-10-23T15:59:59Z'));
		expect(await f.send('/签到')).toContain('签到成功');
		expect(await f.send('/签到', '200', { ...group, groupId: '101' })).toContain('已经签到');
		f.setTime(Date.parse('2026-10-23T16:00:00Z'));
		expect(await f.send('/签到')).toContain('余额 60');
	});
	test('unbound and insufficient-balance actors cannot move', async () => {
		const f = fixture();
		expect(await f.send('/换边 蓝')).toContain('请先');
		await f.bind();
		expect(await f.send('/换边 蓝')).toContain('积分不足');
		expect(await f.send('/确认 111112')).toContain('没有找到');
		expect(f.moves).toHaveLength(0);
	});
	test('concurrent repeated confirmations debit and dispatch only once; replay and cooldown remain safe', async () => {
		const f = fixture();
		await f.bind();
		await f.send('/签到');
		const code = await f.quote();
		await Promise.all([f.send(`/确认 ${code}`), f.send(`/确认 ${code}`), f.send(`/确认 ${code}`)]);
		expect(f.moves).toEqual([{ steamId: STEAM, faction: 'Blue' }]);
		expect(f.store.balance(group.communityId, '200')).toBe(10);
		expect(await f.send(`/确认 ${code}`)).toContain('成功执行');
		expect(f.moves).toHaveLength(1);
		expect(await f.send('/换边 绿')).toContain('冷却中');
	});
	test('another actor or server cannot use a confirmation', async () => {
		const f = fixture();
		await f.bind();
		await f.bind('201', OTHER_STEAM);
		await f.send('/签到');
		await f.send('/签到', '201');
		const code = await f.quote();
		expect(await f.send(`/确认 ${code}`, '201')).toContain('没有找到');
		expect(await f.send(`/确认 ${code}`, '200', { ...group, serverId: 'another' })).toContain(
			'没有找到'
		);
		expect(f.moves).toHaveLength(0);
	});
	test('confirmation rechecks membership, faction, capability, snapshot freshness, expiry and price', async () => {
		const f = fixture();
		await f.bind();
		await f.send('/签到');
		const code = await f.quote();
		f.snapshot.canMove = false;
		expect(await f.send(`/确认 ${code}`)).toContain('未开放');
		f.snapshot.canMove = true;
		f.snapshot.players[0].faction = 'Blue';
		expect(await f.send(`/确认 ${code}`)).toContain('已经在');
		f.snapshot.players[0].faction = 'Red';
		const players = f.snapshot.players;
		f.snapshot.players = [];
		expect(await f.send(`/确认 ${code}`)).toContain('不在');
		f.snapshot.players = players;
		expect(await f.send(`/确认 ${code}`, '200', { ...group, moveCost: 21 })).toContain(
			'配置已更新'
		);
		f.api.snapshot = async () => ({ ...f.snapshot, observedAt: f.time() - 20_000 });
		expect(await f.send(`/确认 ${code}`)).toContain('状态已过期');
		f.setTime(f.time() + 120_000);
		expect(await f.send(`/确认 ${code}`)).toContain('已过期');
		expect(f.moves).toHaveLength(0);
		expect(f.store.balance(group.communityId, '200')).toBe(30);
	});
	test('explicit refusal refunds once, unknown errors hold funds and block new moves', async () => {
		const f = fixture();
		await f.bind();
		await f.send('/签到');
		f.api.move = async () => {
			throw new WarconError('denied', 'refused');
		};
		const refused = await f.quote();
		expect(await f.send(`/确认 ${refused}`)).toContain('已退回');
		expect(await f.send(`/确认 ${refused}`)).toContain('已退回');
		expect(f.store.balance(group.communityId, '200')).toBe(30);
		f.api.move = async () => {
			throw new Error('timeout');
		};
		const unknown = await f.quote();
		expect(await f.send(`/确认 ${unknown}`)).toContain('结果暂不确定');
		expect(f.store.balance(group.communityId, '200')).toBe(10);
		expect(await f.send(`/确认 ${unknown}`)).toContain('结果暂不确定');
		expect(await f.send('/换边 绿')).toContain('待管理员核实');
		expect(await f.send('/积分')).toContain('换边暂扣：20');
		expect(f.store.listUnknown()).toHaveLength(1);
	});
});

describe('configuration revision across command await boundaries', () => {
	test('stale commands are rejected before synchronous persistence', async () => {
		const f = fixture();
		await f.bind();
		const handler = new CommandHandler(f.store, f.api, {
			now: f.time,
			configurationRevision: () => 'new'
		});
		const message = {
			id: 'revision-checkin',
			groupId: group.groupId,
			userId: '200',
			text: '/签到',
			time: f.time(),
			configurationRevision: 'old'
		};
		expect(await handler.handle(message, group)).toContain('配置已更新');
		expect(f.store.balance(group.communityId, '200')).toBe(0);
		expect(await handler.handle({ ...message, configurationRevision: 'new' }, group)).toContain(
			'签到成功'
		);
		expect(f.store.balance(group.communityId, '200')).toBe(30);
	});

	test('a microtask edit after a snapshot resolves prevents binding challenge creation and whisper', async () => {
		const f = fixture();
		let revision = 'old';
		let resolve!: (snapshot: GameSnapshot) => void;
		f.api.snapshot = () =>
			new Promise<GameSnapshot>((done) => {
				resolve = done;
			});
		const handler = new CommandHandler(f.store, f.api, {
			now: f.time,
			code: () => '234567',
			configurationRevision: () => revision
		});
		const message = {
			id: 'revision-bind',
			groupId: group.groupId,
			userId: '200',
			text: `/绑定 ${STEAM}`,
			time: f.time(),
			configurationRevision: revision
		};
		const pending = handler.handle(message, group);
		resolve(f.snapshot);
		queueMicrotask(() => {
			revision = 'new';
		});
		expect(await pending).toContain('配置已更新');
		expect(f.whispers).toEqual([]);
		expect(() => f.store.verifyBinding(group.communityId, '200', '234567', f.time())).toThrow(
			'不存在'
		);
		f.api.snapshot = async () => f.snapshot;
		expect(await handler.handle({ ...message, configurationRevision: revision }, group)).toContain(
			'已向游戏中'
		);
		expect(f.whispers).toHaveLength(1);
	});

	test('a microtask edit after confirm observation prevents claim and dispatch', async () => {
		const f = fixture();
		await f.bind();
		await f.send('/签到');
		const code = await f.quote();
		let revision = 'old';
		let resolve!: (snapshot: GameSnapshot) => void;
		f.api.snapshot = () =>
			new Promise<GameSnapshot>((done) => {
				resolve = done;
			});
		const handler = new CommandHandler(f.store, f.api, {
			now: f.time,
			configurationRevision: () => revision
		});
		const pending = handler.handle(
			{
				id: 'revision-confirm',
				groupId: group.groupId,
				userId: '200',
				text: `/确认 ${code}`,
				time: f.time(),
				configurationRevision: revision
			},
			group
		);
		resolve(f.snapshot);
		queueMicrotask(() => {
			revision = 'new';
		});
		expect(await pending).toContain('配置已更新');
		expect(f.moves).toEqual([]);
		expect(f.store.balance(group.communityId, '200')).toBe(30);
		expect(f.store.pending(group.communityId, STEAM)).toBeNull();
	});

	test('a configuration edit after dispatch cannot cancel recording a successful remote move', async () => {
		const f = fixture();
		await f.bind();
		await f.send('/签到');
		const code = await f.quote();
		let revision = 'old';
		let complete!: () => void;
		let started!: () => void;
		const dispatched = new Promise<void>((done) => {
			started = done;
		});
		f.api.move = () => {
			started();
			return new Promise<void>((done) => {
				complete = done;
			});
		};
		const handler = new CommandHandler(f.store, f.api, {
			now: f.time,
			configurationRevision: () => revision
		});
		const pending = handler.handle(
			{
				id: 'revision-after-dispatch',
				groupId: group.groupId,
				userId: '200',
				text: `/确认 ${code}`,
				time: f.time(),
				configurationRevision: revision
			},
			group
		);
		await dispatched;
		expect(f.store.pending(group.communityId, STEAM)?.state).toBe('running');
		revision = 'new';
		f.store.invalidateConfirmations();
		complete();
		expect(await pending).toContain('成功执行');
		expect(f.store.balance(group.communityId, '200')).toBe(10);
		expect(f.store.listOperations()[0].state).toBe('succeeded');
		expect(f.store.listUnknown()).toEqual([]);
	});
});
