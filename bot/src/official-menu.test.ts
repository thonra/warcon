import { expect, test } from 'bun:test';
import { OfficialMenus, validateMenu, MenuError, type MenuSnapshot } from './official-menu';
import type { MessagingSettings } from './admin-contracts';
import type { QQBotOptions } from '@tencent-connect/qqbot-nodejs';
const item = { type: 'command' as const, name: '帮助', desc: '查看帮助', only_admin: false };
function fixture() {
	let credentials: MessagingSettings = {
		provider: 'official',
		appId: '1234567890',
		appSecret: 'synthetic-secret'
	};
	let cloud: any = null;
	let fail: 'none' | 'applied' | 'before' | 'refused' = 'none';
	let tokenGate: Promise<string> | null = null;
	const calls: { method: string; path: string; body: any }[] = [];
	const checkpoints: MenuSnapshot[] = [];
	const menus = new OfficialMenus(
		() => credentials,
		(_options: QQBotOptions) =>
			({
				tokenManager: {
					getAccessToken: async () => (tokenGate ? await tokenGate : 'synthetic-token')
				},
				apiClient: {
					request: async (_token: string, method: string, path: string, body: any) => {
						calls.push({ method, path, body });
						if (method === 'GET' && path.startsWith('/v2/panels?'))
							return { records: cloud ? [cloud] : [], is_end: true };
						if (method === 'GET') return cloud;
						if (fail === 'before') throw { httpStatus: 0, message: 'secret upstream payload' };
						if (fail === 'refused') throw { bizCode: 40030020, message: 'private raw response' };
						cloud = {
							panel_id: 'p_test',
							scope: 'group',
							target_type: 'all',
							panel: {
								...body.panel,
								items: body.panel.items.map((x: any) => ({
									type: x.type,
									name: x.name.replace(/^\//, ''),
									desc: x.desc,
									...(x.link ? { link: x.link } : {}),
									...(x.only_admin ? { only_admin: true } : {})
								}))
							},
							version: (cloud?.version ?? 0) + 1
						};
						if (fail === 'applied') throw { httpStatus: 0 };
						return method === 'POST' ? { panel_id: 'p_test' } : { version: cloud.version };
					}
				}
			}) as any
	);
	return {
		menus,
		calls,
		checkpoints,
		checkpoint: (x: MenuSnapshot) => checkpoints.push(x),
		setCloud: (x: any) => (cloud = x),
		getCloud: () => cloud,
		setFail: (x: typeof fail) => (fail = x),
		setCredentials: (x: MessagingSettings) => (credentials = x),
		setToken: (x: Promise<string>) => (tokenGate = x)
	};
}
test('menu validates platform limits, member visibility and safe link types', () => {
	expect(validateMenu([{ ...item, name: '/帮助' }])).toEqual([item]);
	expect(
		validateMenu([{ ...item, type: 'link', name: '官网', link: 'https://example.com' }])[0].link
	).toBe('https://example.com/');
	for (const bad of [
		[{ ...item, name: '八个汉字名称测试' }],
		[{ ...item, only_admin: 'false' }],
		[item, item],
		Array(21).fill(item),
		[{ ...item, type: 'link', link: 'javascript:alert(1)' }],
		[{ ...item, type: 'link', link: 'https://user:pass@example.com' }]
	])
		expect(() => validateMenu(bad)).toThrow(MenuError);
});
test('unknown create delivery is reconciled by read without creating a duplicate panel', async () => {
	const f = fixture();
	const before = await f.menus.read();
	f.setFail('applied');
	const result = await f.menus.save({ ...before, items: [item] }, f.checkpoint);
	expect(result).toMatchObject({ panelId: 'p_test', version: 1, items: [item] });
	expect(f.checkpoints).toHaveLength(1);
	expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
	await expect(f.menus.save({ ...before, items: [item] }, f.checkpoint)).rejects.toMatchObject({
		status: 409
	});
	expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
});
test('stale menu versions and changed applications cannot overwrite current menus', async () => {
	const f = fixture();
	const empty = await f.menus.read();
	await f.menus.save({ ...empty, items: [item] }, f.checkpoint);
	const first = await f.menus.read();
	const second = await f.menus.save(
		{ ...first, items: [{ ...item, desc: '新说明' }] },
		f.checkpoint
	);
	expect(second.version).toBe(2);
	const writes = () => f.calls.filter((c) => c.method !== 'GET').length;
	const previous = writes();
	await expect(
		f.menus.save({ ...first, items: [{ ...item, desc: '过期说明' }] }, f.checkpoint)
	).rejects.toMatchObject({ status: 409 });
	f.setCredentials({ provider: 'official', appId: '0987654321', appSecret: 'new-secret' });
	await expect(f.menus.save({ ...second, items: [item] }, f.checkpoint)).rejects.toMatchObject({
		status: 409
	});
	expect(writes()).toBe(previous);
});
test('uncertain writes are never repeated and definite errors do not expose upstream contents', async () => {
	const f = fixture();
	const empty = await f.menus.read();
	f.setFail('before');
	await expect(f.menus.save({ ...empty, items: [item] }, f.checkpoint)).rejects.toMatchObject({
		code: 'menu_unknown'
	});
	expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
	f.setFail('refused');
	try {
		await f.menus.save({ ...empty, items: [item] }, f.checkpoint);
		throw new Error('Expected refusal');
	} catch (e) {
		expect((e as Error).message).toContain('40030020');
		expect((e as Error).message).not.toContain('private raw response');
	}
	expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
});
test('credential rotation during token retrieval retires the pending menu write', async () => {
	const f = fixture();
	let release!: (x: string) => void;
	f.setToken(new Promise((r) => (release = r)));
	const pending = f.menus.save(
		{ appId: '1234567890', panelId: null, version: null, items: [item] },
		f.checkpoint
	);
	f.setCredentials({ provider: 'official', appId: '0987654321', appSecret: 'rotated' });
	release('token');
	await expect(pending).rejects.toMatchObject({ status: 409 });
	expect(f.calls).toHaveLength(0);
});

test('unchanged menu does not write and invalid upstream items are reported as an upstream failure', async () => {
	const f = fixture();
	const empty = await f.menus.read();
	const created = await f.menus.save({ ...empty, items: [item] }, f.checkpoint);
	const writes = f.calls.filter((c) => c.method !== 'GET').length;
	expect(await f.menus.save(created, f.checkpoint)).toEqual(created);
	expect(f.calls.filter((c) => c.method !== 'GET')).toHaveLength(writes);
	expect(f.checkpoints).toHaveLength(1);
	f.setCloud({ ...f.getCloud(), panel: { items: [{ type: 'unsupported', name: 'test' }] } });
	await expect(f.menus.read()).rejects.toMatchObject({ status: 502 });
});
