import { QQBot, type QQBotOptions } from '@tencent-connect/qqbot-nodejs';
import type { MessagingSettings } from './admin-contracts';

export interface MenuItem {
	type: 'command' | 'link';
	name: string;
	desc: string;
	only_admin: boolean;
	link?: string;
}
export interface MenuSnapshot {
	appId: string;
	panelId: string | null;
	version: number | null;
	items: MenuItem[];
	remark: string;
}
export interface MenuPort {
	read(): Promise<MenuSnapshot>;
	save(input: unknown, checkpoint: (before: MenuSnapshot) => void): Promise<MenuSnapshot>;
}
export class MenuError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly code = 'menu_error'
	) {
		super(message);
	}
}
export const DEFAULT_MENU: MenuItem[] = [
	['帮助', '查看全部命令和使用方法'],
	['绑定', '绑定本人的 Steam 账号'],
	['签到', '每日签到领取积分'],
	['积分', '查询积分与免排队状态'],
	['服务器', '查看人数、地图和比分'],
	['查对局', '查询本局与个人战绩'],
	['换边蓝', '查看费用并申请加入蓝方'],
	['换边红', '查看费用并申请加入红方'],
	['换边绿', '查看费用并申请加入绿方'],
	['取消', '取消绑定或待确认换边']
].map(([name, desc]) => ({ type: 'command', name, desc, only_admin: false }));
const width = (s: string) => [...s].reduce((n, c) => n + (c.codePointAt(0)! > 127 ? 2 : 1), 0);
export function validateMenu(raw: unknown): MenuItem[] {
	if (!Array.isArray(raw) || raw.length > 20) throw new MenuError(400, '菜单最多包含20项');
	const names = new Set<string>();
	return raw.map((item) => {
		if (
			!item ||
			!['command', 'link'].includes(item.type) ||
			typeof item.name !== 'string' ||
			typeof item.desc !== 'string' ||
			typeof item.only_admin !== 'boolean'
		)
			throw new MenuError(400, '菜单项格式无效');
		const name = item.type === 'command' ? item.name.trim().replace(/^\/+/, '') : item.name.trim();
		const desc = item.desc.trim();
		if (
			!name ||
			width(name) > 14 ||
			width(desc) > 30 ||
			/[\x00-\x1f\x7f]/.test(name + desc) ||
			names.has(name)
		)
			throw new MenuError(400, '名称需唯一且不超过7个汉字，描述不超过15个汉字');
		names.add(name);
		const result: MenuItem = { type: item.type, name, desc, only_admin: item.only_admin };
		if (item.type === 'link') {
			try {
				const url = new URL(item.link);
				if (url.protocol !== 'https:' || url.username || url.password || item.link.length > 2048)
					throw new Error();
				result.link = url.href;
			} catch {
				throw new MenuError(400, '链接需为不包含账号密码的 HTTPS 地址');
			}
		}
		return result;
	});
}
type Client = Pick<QQBot, 'apiClient' | 'tokenManager'>;
export class OfficialMenus implements MenuPort {
	private saving = false;
	constructor(
		private credentials: () => MessagingSettings,
		private factory: (options: QQBotOptions) => Client = (options) => new QQBot(options)
	) {}
	private async session(expectedAppId?: string) {
		const { appId, appSecret } = this.credentials();
		if (!appId || !appSecret) throw new MenuError(503, '请先配置官方机器人 AppID 和 AppSecret');
		if (expectedAppId !== undefined && appId !== expectedAppId)
			throw new MenuError(409, '机器人应用已切换，请重新读取菜单', 'menu_conflict');
		const client = this.factory({
			appId,
			appSecret,
			baseUrl: 'https://api.bot.qq.com',
			tokenBaseUrl: 'https://api.bot.qq.com'
		});
		const current = () => {
			const c = this.credentials();
			if (c.appId !== appId || c.appSecret !== appSecret)
				throw new MenuError(409, '机器人应用已切换，请重新读取菜单', 'menu_conflict');
		};
		const token = await client.tokenManager.getAccessToken(appId, appSecret);
		current();
		return {
			appId,
			current,
			call: async (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<any> => {
				current();
				const result: any = await client.apiClient.request(token, method, path, body, {
					timeoutMs: 8000
				});
				if (result?.code || result?.err_code) throw { bizCode: result.code || result.err_code };
				current();
				return result;
			}
		};
	}
	private failure(error: unknown): MenuError {
		if (error instanceof MenuError) return error;
		const code = (error as { bizCode?: unknown })?.bizCode;
		return new MenuError(
			502,
			'腾讯菜单接口暂不可用' +
				(typeof code === 'number' && Number.isSafeInteger(code) ? '（代码 ' + code + '）' : '')
		);
	}
	private async snapshot(
		session: Awaited<ReturnType<OfficialMenus['session']>>
	): Promise<MenuSnapshot> {
		const records: any[] = [];
		let cursor = '';
		for (let i = 0; i < 10; i++) {
			const page = await session.call(
				'GET',
				'/v2/panels?scope=group&limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
			);
			if (!Array.isArray(page?.records)) throw new MenuError(502, '腾讯返回的菜单列表格式无效');
			records.push(...page.records);
			if (page.is_end || !page.next_cursor) break;
			cursor = page.next_cursor;
			if (i === 9) throw new MenuError(502, '菜单列表未能完整读取');
		}
		const global = records.filter((x) => x.scope === 'group' && x.target_type === 'all');
		if (global.length > 1) throw new MenuError(409, '存在多个群聊全局面板，请先在开放平台合并菜单');
		if (!global.length)
			return {
				appId: session.appId,
				panelId: null,
				version: null,
				items: [],
				remark: 'Warcon 群聊自助菜单'
			};
		const panelId = global[0].panel_id;
		if (typeof panelId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(panelId))
			throw new MenuError(502, '腾讯返回的菜单标识无效');
		const detail = await session.call('GET', '/v2/panels/' + encodeURIComponent(panelId));
		if (
			detail.scope !== 'group' ||
			detail.target_type !== 'all' ||
			detail.panel_id !== panelId ||
			!Number.isSafeInteger(detail.version) ||
			!Array.isArray(detail.panel?.items)
		)
			throw new MenuError(502, '腾讯返回的菜单详情格式无效');
		let items: MenuItem[];
		try {
			items = validateMenu(
				detail.panel.items.map((x: any) => ({
					...x,
					desc: x.desc ?? '',
					only_admin: x.only_admin ?? false
				}))
			);
		} catch {
			throw new MenuError(502, '腾讯返回的菜单项格式无效');
		}
		return {
			appId: session.appId,
			panelId,
			version: detail.version,
			items,
			remark: detail.panel.remark ?? ''
		};
	}
	async read(): Promise<MenuSnapshot> {
		try {
			return await this.snapshot(await this.session());
		} catch (e) {
			throw this.failure(e);
		}
	}
	async save(input: unknown, checkpoint: (before: MenuSnapshot) => void): Promise<MenuSnapshot> {
		if (this.saving) throw new MenuError(409, '菜单正在保存，请稍候再操作', 'menu_conflict');
		this.saving = true;
		let writing = false;
		try {
			const data = input as Partial<MenuSnapshot>;
			if (
				!data ||
				typeof data.appId !== 'string' ||
				!(data.panelId === null || typeof data.panelId === 'string') ||
				!(data.version === null || Number.isSafeInteger(data.version))
			)
				throw new MenuError(400, '菜单版本无效，请重新读取');
			const items = validateMenu(data.items);
			const session = await this.session(data.appId);
			const before = await this.snapshot(session);
			if (data.panelId !== before.panelId || data.version !== before.version)
				throw new MenuError(409, '菜单已被其他页面修改，请重新读取', 'menu_conflict');
			if (JSON.stringify(items) === JSON.stringify(before.items)) return before;
			checkpoint(before);
			session.current();
			writing = true;
			try {
				if (before.panelId)
					await session.call('PUT', '/v2/panels/' + encodeURIComponent(before.panelId), {
						panel: { items, remark: before.remark, version: before.version }
					});
				else
					await session.call('POST', '/v2/panels', {
						scope: 'group',
						target_type: 'all',
						panel: { items, remark: before.remark }
					});
			} catch (error) {
				if (error instanceof MenuError) throw error;
				const code = (error as { bizCode?: unknown; httpStatus?: unknown })?.bizCode;
				const status = (error as { httpStatus?: number })?.httpStatus;
				if (
					(typeof code === 'number' && code !== 0) ||
					(typeof status === 'number' && status >= 400 && status < 500)
				)
					throw this.failure(error);
				// A timed-out write is reconciled by reading, never by repeating the mutation.
			}
			const after = await this.snapshot(session);
			if (JSON.stringify(after.items) !== JSON.stringify(items))
				throw new MenuError(502, '保存结果尚未确认，请重新读取菜单核对后再操作', 'menu_unknown');
			return after;
		} catch (e) {
			if (e instanceof MenuError) throw e;
			if (writing)
				throw new MenuError(502, '保存结果尚未确认，请重新读取菜单核对后再操作', 'menu_unknown');
			throw this.failure(e);
		} finally {
			this.saving = false;
		}
	}
}
