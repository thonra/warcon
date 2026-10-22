import { expect, test } from 'bun:test';
import type { ManagedServer } from './admin-contracts';
import type { GameSnapshot, GroupConfig, WarconPort } from './contracts';
import { CommandHandler } from './commands';
import { ManagedWarcon } from './managed-warcon';
import { BotStore } from './store';

// The barrier proves the settings edit happens during observation, not before dispatch starts.
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test('a settings edit during a pending snapshot prevents game execution and debit; fresh retry succeeds', async () => {
	const now = 1792700000000;
	const steamId = '76561198000000001';
	const group: GroupConfig = {
		groupId: '123456',
		communityId: 'community',
		serverId: 's1',
		serverName: '测试服',
		timezone: 'Asia/Shanghai',
		checkinPoints: 30,
		moveCost: 20,
		moveCooldownSeconds: 300,
		factions: { 蓝: 'Blue', 红: 'Red', 绿: 'Green' }
	};
	let revision = 1;
	let settings: ManagedServer[] = [
		{
			id: 's1',
			name: '测试服',
			mode: 'wardogs',
			scheme: 'http',
			host: 'old-server.test',
			port: 7779,
			password: 'test-only-password',
			warconUrl: '',
			warconToken: ''
		}
	];
	const snapshot: GameSnapshot = {
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
	const started = deferred<void>();
	const observation = deferred<GameSnapshot>();
	let pause = false;
	const reads: string[] = [];
	const moves: string[] = [];
	const managed = new ManagedWarcon(
		() => settings,
		() => revision,
		(server): WarconPort => ({
			snapshot: async () => {
				reads.push(server.host);
				if (pause) {
					started.resolve();
					return observation.promise;
				}
				return snapshot;
			},
			whisper: async () => {
				throw new Error('This test must not whisper');
			},
			move: async (_serverId, player, faction) => {
				expect(player).toBe(steamId);
				expect(faction).toBe('Blue');
				moves.push(server.host);
			},
			reserved: async () => ({ state: 'none', expiresAt: null })
		})
	);
	const store = new BotStore(':memory:');
	try {
		store.beginBinding(group.communityId, '123457', steamId, '123456', now);
		store.verifyBinding(group.communityId, '123457', '123456', now);
		store.checkin(group.communityId, '123457', '2026-10-23', 30, now);
		let code = 234567;
		const handler = new CommandHandler(store, managed, {
			now: () => now,
			code: () => String(code++)
		});
		let id = 0;
		const send = (text: string) =>
			handler.handle(
				{ id: String(++id), groupId: group.groupId, userId: '123457', text, time: now },
				group
			);
		expect(await send('/换边 蓝')).toContain('/确认 234567');
		pause = true;
		const pending = send('/确认 234567');
		await started.promise;
		settings = [{ ...settings[0], host: 'new-server.test' }];
		revision++;
		// Deliberately do not invalidate confirmations here: this isolates the pending-snapshot guard.
		observation.resolve(snapshot);
		expect(await pending).not.toContain('成功执行');
		expect(reads).toEqual(['old-server.test', 'old-server.test']);
		expect(moves).toEqual([]);
		expect(store.balance(group.communityId, '123457')).toBe(30);
		expect(store.pending(group.communityId, steamId)).toBeNull();

		pause = false;
		expect(await send('/换边 蓝')).toContain('/确认 234568');
		expect(await send('/确认 234568')).toContain('成功执行');
		expect(moves).toEqual(['new-server.test']);
		expect(store.balance(group.communityId, '123457')).toBe(10);
	} finally {
		store.close();
	}
});

test('a microtask edit after ManagedWarcon validates a snapshot cannot recreate an invalidated old quote', async () => {
	const now = 1792700000000;
	const steamId = '76561198000000001';
	const group: GroupConfig = {
		groupId: '123456',
		communityId: 'community',
		serverId: 's1',
		serverName: '测试服',
		timezone: 'Asia/Shanghai',
		checkinPoints: 30,
		moveCost: 20,
		moveCooldownSeconds: 300,
		factions: { 蓝: 'Blue', 红: 'Red', 绿: 'Green' }
	};
	let revision = 1;
	let settings: ManagedServer[] = [
		{
			id: 's1',
			name: '测试服',
			mode: 'wardogs',
			scheme: 'http',
			host: 'old-server.test',
			port: 7779,
			password: 'test-only-password',
			warconUrl: '',
			warconToken: ''
		}
	];
	const snapshot: GameSnapshot = {
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
	const observation = deferred<GameSnapshot>();
	const checks: number[] = [];
	const moves: string[] = [];
	let paused = true;
	const managed = new ManagedWarcon(
		() => settings,
		() => {
			checks.push(revision);
			return revision;
		},
		(server): WarconPort => ({
			// Returning the promise directly is essential: an async wrapper changes the microtask order.
			snapshot: () => (paused ? observation.promise : Promise.resolve(snapshot)),
			whisper: async () => {
				throw new Error('This test must not whisper');
			},
			move: async () => {
				moves.push(server.host);
			},
			reserved: async () => ({ state: 'none', expiresAt: null })
		})
	);
	const store = new BotStore(':memory:');
	try {
		store.beginBinding(group.communityId, '123457', steamId, '123456', now);
		store.verifyBinding(group.communityId, '123457', '123456', now);
		store.checkin(group.communityId, '123457', '2026-10-23', 30, now);
		const handler = new CommandHandler(store, managed, {
			now: () => now,
			code: () => '234567',
			configurationRevision: () => String(revision)
		});
		let id = 0;
		const send = (text: string) =>
			handler.handle(
				{
					id: String(++id),
					groupId: group.groupId,
					userId: '123457',
					text,
					time: now,
					configurationRevision: String(revision)
				},
				group
			);
		const oldQuote = send('/换边 蓝');
		observation.resolve(snapshot);
		queueMicrotask(() => {
			revision++;
			settings = [{ ...settings[0], host: 'new-server.test' }];
			store.invalidateConfirmations();
		});
		expect(await oldQuote).toContain('配置已更新');
		// ManagedWarcon's own check saw revision 1 twice and did not reject the snapshot.
		expect(checks).toEqual([1, 1]);
		expect(() =>
			store.confirmation(group.communityId, '123457', group.serverId, '234567', now)
		).toThrow('没有找到');
		expect(await send('/确认 234567')).toContain('没有找到');
		expect(moves).toEqual([]);
		expect(store.balance(group.communityId, '123457')).toBe(30);

		paused = false;
		expect(await send('/换边 蓝')).toContain('/确认 234567');
		expect(await send('/确认 234567')).toContain('成功执行');
		expect(moves).toEqual(['new-server.test']);
		expect(store.balance(group.communityId, '123457')).toBe(10);
	} finally {
		store.close();
	}
});
