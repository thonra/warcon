import { expect, test } from 'bun:test';
import { ManagerStore } from './manager-store';
import { ManagementHandler } from './management';
import type { BotMessage, GroupConfig } from './contracts';
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
const msg = (text: string, userId = '694665944', id = crypto.randomUUID()): BotMessage => ({
	id,
	groupId: group.groupId,
	userId,
	text,
	time: Date.now(),
	configurationRevision: 'config'
});
function fixture() {
	const store = new ManagerStore(':memory:');
	store.save(0, [{ qq: '694665944', label: 'owner', enabled: true, serverIds: ['s'] }]);
	const calls: any[] = [];
	let block: Promise<void> | undefined;
	const remote = {
		prepare: async (_s: string, command: string, args: string) => ({
			expected: 'v1',
			summary: command + ' ' + args
		}),
		execute: async (_s: string, command: string, args: string) => {
			calls.push({ command, args });
			if (block) await block;
			return '完成';
		},
		read: async () => '查询结果'
	};
	const handler = new ManagementHandler(store, remote, () => 'config');
	return { store, handler, calls, block: (p: Promise<void>) => (block = p) };
}
test('management commands authorize raw sender, remain hidden from normal help, and scope every request', async () => {
	const f = fixture();
	try {
		expect(await f.handler.handle(msg('/帮助'), group)).toBeNull();
		expect(await f.handler.handle(msg('/踢出 76561198000000001 理由', '12345'), group)).toContain(
			'无管理权限'
		);
		expect(f.calls).toHaveLength(0);
		expect(await f.handler.handle(msg('/管理帮助'), group)).toContain('/欢迎私信');
		expect(await f.handler.handle(msg('/管理帮助'), { ...group, serverId: 'other' })).toContain(
			'无管理权限'
		);
	} finally {
		f.store.close();
	}
});
test('confirmed management writes execute once and revoked identities cannot confirm', async () => {
	const f = fixture();
	try {
		const quote = await f.handler.handle(msg('/踢出 76561198000000001 理由'), group);
		const code = quote!.match(/\/执行 ([a-f0-9]{8})/)![1];
		expect(f.calls).toHaveLength(0);
		expect(await f.handler.handle(msg('/执行 ' + code, '12345'), group)).toContain('无管理权限');
		expect(await f.handler.handle(msg('/执行 ' + code), group)).toContain('完成');
		await f.handler.handle(msg('/执行 ' + code), group);
		expect(f.calls).toHaveLength(1);
		const q = await f.handler.handle(msg('/踢出 76561198000000001 再次'), group);
		const next = q!.match(/\/执行 ([a-f0-9]{8})/)![1];
		f.store.save(f.store.policy().revision, []);
		expect(await f.handler.handle(msg('/执行 ' + next), group)).toContain('无管理权限');
		expect(f.calls).toHaveLength(1);
	} finally {
		f.store.close();
	}
});
test('official QQ identities require explicit administrator-approved linkage and stay app/group scoped', async () => {
	const f = fixture();
	try {
		const official = {
			...msg('/管理帮助', 'qqofficial:1905900177:groupA:memberA'),
			officialReply: {
				appId: '1905900177',
				groupOpenid: 'groupA',
				messageId: 'm',
				revision: 'config'
			}
		};
		expect(await f.handler.handle(official, group)).toContain('无管理权限');
		const identity = await f.handler.handle({ ...official, text: '/管理身份' }, group);
		const code = identity!.match(/身份码 ([a-f0-9]{8})/)![1];
		f.store.bind(f.store.policy().revision, '694665944', code);
		expect(await f.handler.handle(official, group)).toContain('/每日重启');
		expect(
			await f.handler.handle(
				{
					...official,
					userId: 'qqofficial:1905900177:groupB:memberA',
					officialReply: { ...official.officialReply, groupOpenid: 'groupB' }
				},
				group
			)
		).toContain('无管理权限');
		expect(() => f.store.bind(f.store.policy().revision, '694665944', code)).toThrow();
	} finally {
		f.store.close();
	}
});
test('ambiguous writes are not repeated and pending confirmations cannot cross configuration revisions', async () => {
	const f = fixture();
	try {
		const quote = await f.handler.handle(msg('/结束对局'), group);
		const code = quote!.match(/\/执行 ([a-f0-9]{8})/)![1];
		expect(
			await f.handler.handle({ ...msg('/执行 ' + code), configurationRevision: 'different' }, group)
		).toContain('配置');
		expect(f.calls).toHaveLength(0);
	} finally {
		f.store.close();
	}
});

test('uncertain actions stay terminal and identity revocation applies after awaits', async () => {
	const store = new ManagerStore(':memory:');
	store.save(0, [{ qq: '694665944', label: 'owner', enabled: true, serverIds: ['s'] }]);
	let executions = 0;
	let fail = true;
	let block: Promise<void> | undefined;
	const remote = {
		prepare: async () => {
			if (block) await block;
			return { expected: 'v1', summary: 'test' };
		},
		read: async () => 'query',
		execute: async () => {
			executions++;
			if (fail) throw new Error('network timeout');
			return 'done';
		}
	};
	const handler = new ManagementHandler(store, remote, () => 'config');
	try {
		const q = await handler.handle(msg('/结束对局'), group);
		const code = q!.match(/\/执行 ([a-f0-9]{8})/)![1];
		expect(await handler.handle(msg('/执行 ' + code), group)).toContain('暂不确定');
		await handler.handle(msg('/执行 ' + code), group);
		expect(executions).toBe(1);
		expect(await handler.handle(msg('/结束对局'), group)).toContain('仍待核实');
		expect(executions).toBe(1);
		store.reconcile(store.recent()[0].id, '已经在测试服务核实');
		fail = false;
		const q2 = await handler.handle(msg('/结束对局'), group);
		const code2 = q2!.match(/\/执行 ([a-f0-9]{8})/)![1];
		let release!: () => void;
		block = new Promise((r) => (release = r));
		const confirm = handler.handle(msg('/执行 ' + code2), group);
		store.save(store.policy().revision, []);
		release();
		expect(await confirm).toContain('权限');
		expect(executions).toBe(1);
	} finally {
		store.close();
	}
});

test('two concurrent confirmations can dispatch only one management write', async () => {
	const f = fixture();
	try {
		const q = await f.handler.handle(msg('/结束对局'), group);
		const code = q!.match(/\/执行 ([a-f0-9]{8})/)![1];
		let release!: () => void;
		f.block(new Promise((r) => (release = r)));
		const first = f.handler.handle(msg('/执行 ' + code), group);
		const second = f.handler.handle(msg('/执行 ' + code), group);
		await new Promise((r) => setTimeout(r, 0));
		expect(f.calls).toHaveLength(1);
		release();
		await Promise.all([first, second]);
		expect(f.calls).toHaveLength(1);
	} finally {
		f.store.close();
	}
});

test('public help contains none of the hidden staff command names', async () => {
	const { CommandHandler } = await import('./commands');
	const { BotStore } = await import('./store');
	const { MANAGEMENT_COMMANDS } = await import('./management-catalog');
	const store = new BotStore(':memory:');
	try {
		const normal = new CommandHandler(store, {} as any);
		const help = await normal.handle(msg('/帮助'), group);
		for (const d of MANAGEMENT_COMMANDS) expect(help).not.toContain('/' + d.name);
	} finally {
		store.close();
	}
});
