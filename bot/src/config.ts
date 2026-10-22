import { readFileSync } from 'node:fs';
import type { GroupConfig } from './contracts';

export interface BotConfig {
	host: string;
	port: number;
	databasePath: string;
	selfId: string;
	autoSelfId?: boolean;
	webhookSecret: string;
	napcatUrl: string;
	napcatToken: string;
	warconUrl: string;
	warconToken: string;
	groups: GroupConfig[];
	managed?: { username: string; password: string; masterKey: string; origin?: string };
	revision?: string;
}
export function qqId(value: unknown): string | null {
	const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
	return typeof id === 'string' && /^[1-9]\d{4,15}$/.test(id) && Number.isSafeInteger(Number(id))
		? id
		: null;
}
export function parseGroups(input: unknown): GroupConfig[] {
	if (!Array.isArray(input) || !input.length) throw new Error('群配置必须是非空数组。');
	const ids = new Set<string>();
	const communities = new Map<string, string>();
	return input.map((raw) => {
		if (!raw || typeof raw !== 'object') throw new Error('群配置格式错误。');
		const groupId = qqId(raw.groupId);
		if (!groupId || ids.has(groupId)) throw new Error('群号必须有效且不能重复。');
		ids.add(groupId);
		for (const key of ['communityId', 'serverId', 'serverName'] as const)
			if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > 100)
				throw new Error(`群配置缺少 ${key}。`);
		const timezone = raw.timezone ?? 'Asia/Shanghai';
		new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
		const integer = (key: string, fallback: number, max: number) => {
			const n = raw[key] ?? fallback;
			if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`${key} 超出范围。`);
			return n as number;
		};
		const factions = raw.factions;
		if (
			!factions ||
			!['蓝', '红', '绿'].every(
				(c) => typeof factions[c] === 'string' && factions[c].trim() && factions[c].length <= 100
			) ||
			new Set(Object.values(factions)).size !== 3
		)
			throw new Error('factions 必须明确配置蓝、红、绿三个不同的游戏阵营名称。');
		const group: GroupConfig = {
			groupId,
			communityId: raw.communityId,
			serverId: raw.serverId,
			serverName: raw.serverName,
			timezone,
			checkinPoints: integer('checkinPoints', 10, 10000),
			moveCost: integer('moveCost', 20, 1000000),
			moveCooldownSeconds: integer('moveCooldownSeconds', 300, 86400),
			factions: { 蓝: factions.蓝, 红: factions.红, 绿: factions.绿 }
		};
		const economicPolicy = JSON.stringify([
			timezone,
			group.checkinPoints,
			group.moveCost,
			group.moveCooldownSeconds
		]);
		if (communities.has(group.communityId) && communities.get(group.communityId) !== economicPolicy)
			throw new Error('同一 communityId 的签到时区、积分与冷却配置必须一致。');
		communities.set(group.communityId, economicPolicy);
		return group;
	});
}
export function httpUrl(raw: string): string {
	const url = new URL(raw);
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error('服务地址必须是 HTTP(S) 地址，不能包含凭据、查询或片段。');
	return url.href.replace(/\/$/, '');
}
/** A fixed browser origin, without paths, credentials, or a proxy-controlled header. */
export function adminOrigin(raw: string): string {
	try {
		const url = new URL(raw);
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.pathname !== '/' ||
			url.search ||
			url.hash
		)
			throw new Error();
		return url.origin;
	} catch {
		throw new Error(
			'QQ_ADMIN_ORIGIN 必须是完整的 HTTP(S) 来源地址，不能包含路径、凭据、查询或片段。'
		);
	}
}
export function loadConfig(env: Record<string, string | undefined> = process.env): BotConfig {
	const valueOf = (key: string) =>
		env[key + '_FILE'] ? readFileSync(env[key + '_FILE']!, 'utf8').trim() : env[key]?.trim();
	const required = (key: string, min = 1) => {
		const value = valueOf(key);
		if (!value || value.length < min) throw new Error(`请配置 ${key}（至少 ${min} 个字符）。`);
		return value;
	};
	if (env.QQ_BOT_AUTO_SELF_ID !== undefined && !['true', 'false'].includes(env.QQ_BOT_AUTO_SELF_ID))
		throw new Error('QQ_BOT_AUTO_SELF_ID 必须是 true 或 false。');
	const autoSelfId = env.QQ_BOT_AUTO_SELF_ID === 'true';
	const selfId = autoSelfId ? '' : qqId(required('QQ_BOT_SELF_ID'));
	if (!autoSelfId && !selfId) throw new Error('QQ_BOT_SELF_ID 无效。');
	const port = Number(env.QQ_BOT_PORT ?? 3100);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('QQ_BOT_PORT 无效。');
	const managed = env.QQ_BOT_MANAGED === 'true';
	const admin = managed
		? {
				username: env.QQ_ADMIN_USER ?? 'admin',
				password: valueOf('QQ_ADMIN_PASSWORD') ?? '',
				masterKey: required('QQ_BOT_MASTER_KEY'),
				...(env.QQ_ADMIN_ORIGIN?.trim() ? { origin: adminOrigin(env.QQ_ADMIN_ORIGIN.trim()) } : {})
			}
		: undefined;
	if (admin && Buffer.from(admin.masterKey, 'base64').length !== 32)
		throw new Error('QQ_BOT_MASTER_KEY 必须是 32 字节密钥的 Base64 编码。');
	return {
		host: env.QQ_BOT_HOST ?? '127.0.0.1',
		port,
		databasePath: env.QQ_BOT_DB ?? './data/qq-bot.sqlite',
		selfId: selfId!,
		autoSelfId,
		webhookSecret: required('NAPCAT_WEBHOOK_SECRET', 24),
		napcatUrl: httpUrl(required('NAPCAT_API_URL')),
		napcatToken: required('NAPCAT_API_TOKEN', 24),
		warconUrl: managed ? '' : httpUrl(required('WARCON_URL')),
		warconToken: managed ? '' : required('WARCON_API_TOKEN'),
		groups: managed
			? []
			: parseGroups(JSON.parse(readFileSync(env.QQ_BOT_GROUPS ?? './bot/groups.json', 'utf8'))),
		...(admin ? { managed: admin } : {})
	};
}
