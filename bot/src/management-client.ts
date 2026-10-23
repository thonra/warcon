import { createHash } from 'node:crypto';
import type { ManagedServer } from './admin-contracts';
import type { GroupConfig } from './contracts';
import { WarconClient } from './warcon';
import { ManagementInputError, type ManagementPort } from './management';
import { MANAGEMENT_COMMANDS } from './management-catalog';
type Obj = Record<string, any>;
interface RequestPlan {
	method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
	path: string;
	body?: Obj;
	expected: string;
	summary: string;
	config?: { key: string; value: string };
}
const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const clean = (x: unknown) =>
	String(x ?? '')
		.replace(/[\x00-\x1f\x7f]/g, ' ')
		.slice(0, 300);
const steam = (v: string) => {
	if (!/^\d{17}$/.test(v))
		throw new ManagementInputError('玩家目标需填写17位 SteamID64，不接受昵称或QQ号');
	return v;
};
const integer = (v: string, min: number, max: number) => {
	if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max)
		throw new ManagementInputError(`数字需为 ${min} 至 ${max} 的整数`);
	return Number(v);
};
const onOff = (v: string) => {
	if (!['开', '关'].includes(v)) throw new ManagementInputError('开关参数为 开 或 关');
	return v === '开';
};
const words = (args: string) => {
	const m = args.match(/^(\S+)(?:\s+([\s\S]+))?$/);
	return [m?.[1] ?? '', m?.[2]?.trim() ?? ''];
};
const id = (s: string) => {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_+.-]{0,127}$/.test(s))
		throw new ManagementInputError('ID格式无效，请先查询对应列表');
	return s;
};
const message = (s: string, max = 256) => {
	if (!s.trim() || s.length > max || /[\x00-\x1f\x7f]/.test(s))
		throw new ManagementInputError(`内容需为1至${max}字，不包含换行或控制字符`);
	return s;
};
export function utcTime(time: string, zone: string): string {
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
		throw new ManagementInputError('时间格式为 HH:MM，例如 07:00');
	const known: Record<string, number> = { UTC: 0, 'Asia/Shanghai': 480, 'Asia/Tokyo': 540 };
	let offset = known[zone];
	if (offset === undefined) {
		const m = /^UTC([+-])(0\d|1[0-4]):([0-5]\d)$/.exec(zone);
		if (!m || (+m[2] === 14 && +m[3] !== 0))
			throw new ManagementInputError('请用 UTC、Asia/Shanghai、Asia/Tokyo 或 UTC+08:00 等固定时区');
		offset = (+m[2] * 60 + +m[3]) * (m[1] === '-' ? -1 : 1);
	}
	const [h, m] = time.split(':').map(Number);
	const v = (h * 60 + m - offset + 1440) % 1440;
	return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}
const lifecycle = '/Script/WDGame.WDServerLifecycleSubsystem';
const session = '/Script/WDGame.WDGameSession';
const configFields: Record<
	string,
	{ section: string; key: string; parse: (args: string, g: GroupConfig) => string }
> = {
	每日重启: {
		section: lifecycle,
		key: 'RestartTimeUtc',
		parse: (a, g) => {
			const [t, z] = words(a);
			return utcTime(t, z || g.timezone);
		}
	},
	恢复默认重启: {
		section: lifecycle,
		key: 'RestartTimeUtc',
		parse: (a) => {
			if (a) throw new ManagementInputError('恢复默认重启不需要参数');
			return '';
		}
	},
	服务器名称: { section: session, key: 'ServerName', parse: (a) => message(a, 80) },
	人数上限: {
		section: '/Script/Engine.GameSession',
		key: 'MaxPlayers',
		parse: (a) => String(integer(a, 1, 256))
	},
	保留槽位: { section: session, key: 'MaxReservedSlots', parse: (a) => String(integer(a, 0, 256)) }
};
/** A narrowly scoped scalar edit; full config documents and secrets never enter QQ or pending operations. */
export function editConfigScalar(text: string, section: string, key: string, value: string) {
	if (/[\r\n\x00]/.test(value)) throw new ManagementInputError('配置值不可换行');
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r\n|\n|\r/);
	let inside = false,
		found = false,
		wrote = false;
	const result: string[] = [];
	for (const line of lines) {
		const h = /^\s*\[([^\]]+)\]\s*$/.exec(line);
		if (h) {
			if (inside && !wrote) {
				result.push(key + '=' + JSON.stringify(value));
				wrote = true;
			}
			inside = h[1].toLowerCase() === section.toLowerCase();
			if (inside) found = true;
			result.push(line);
			continue;
		}
		const k = /^\s*([^;#=]+?)\s*=/.exec(line);
		if (inside && k?.[1].trim().toLowerCase() === key.toLowerCase()) {
			if (!wrote) {
				result.push(key + '=' + JSON.stringify(value));
				wrote = true;
			}
			continue;
		}
		result.push(line);
	}
	if (!found) result.push('', `[${section}]`);
	if (!wrote) result.push(key + '=' + JSON.stringify(value));
	return result.join(eol);
}
export function configScalar(text: string, section: string, key: string) {
	let inside = false,
		value: string | null = null;
	for (const line of text.split(/\r\n|\n|\r/)) {
		const h = /^\s*\[([^\]]+)\]\s*$/.exec(line);
		if (h) {
			inside = h[1].toLowerCase() === section.toLowerCase();
			continue;
		}
		const m = /^\s*([^;#=]+?)\s*=\s*(.*)$/.exec(line);
		if (inside && m?.[1].trim().toLowerCase() === key.toLowerCase()) {
			value = m[2].trim();
			if (value.startsWith('"') && value.endsWith('"')) {
				try {
					value = JSON.parse(value);
				} catch {
					value = m[2].trim().slice(1, -1);
				}
			}
		}
	}
	return value;
}
function selection(args: string) {
	const [map, tail] = words(args);
	id(map);
	const p: Obj = { map };
	if (tail)
		for (const part of tail.split(/\s+/)) {
			const pair = /^(模式|光照|区域)=(\S+)$/.exec(part);
			if (!pair) throw new ManagementInputError('地图参数示例：bakurani 模式=artillery 光照=Day');
			if (pair[1] === '模式') p.experiences = pair[2].split(',').map(id);
			else p[pair[1] === '光照' ? 'lighting' : 'zoneAlternator'] = id(pair[2]);
		}
	return p;
}
function expiry(raw: string) {
	if (raw === '永久') return null;
	const m = /^(\d+)(m|h|d)$/.exec(raw);
	if (!m) throw new ManagementInputError('期限示例：30m、24h、7d 或 永久');
	const ms = +m[1] * { m: 60000, h: 3600000, d: 86400000 }[m[2] as 'm' | 'h' | 'd'];
	if (ms < 60000 || ms > 3650 * 86400000)
		throw new ManagementInputError('期限需在1分钟至3650天之间');
	return ms;
}
const labels: Record<string, string> = {
	steamId: 'SteamID',
	name: '名称',
	faction: '阵营',
	kills: '击杀',
	deaths: '死亡',
	ping: '延迟',
	pingMs: '延迟',
	map: '地图',
	experiences: '模式',
	lighting: '光照',
	zoneAlternator: '区域',
	id: 'ID',
	kind: '类型',
	enabled: '启用',
	reason: '理由',
	note: '备注',
	body: '备注',
	watched: '关注',
	watchReason: '关注理由',
	expiresAt: '到期',
	state: '状态',
	status: '状态',
	createdAt: '创建时间',
	timestampUtc: '时间',
	action: '动作',
	outcome: '结果',
	username: '账号',
	actorName: '操作者',
	display: '名称',
	score: '分数',
	players: '玩家',
	playerCount: '在线人数',
	maxPlayers: '上限',
	duration: '时长',
	durationSeconds: '时长',
	startedAt: '开始时间',
	endedAt: '结束时间',
	winner: '胜方',
	matchId: '对局ID',
	online: '在线',
	total: '合计',
	count: '数量',
	uniquePlayers: '独立玩家',
	uptimePct: '在线率%',
	onlineNow: '当前在线',
	coveredHours: '观测小时',
	fires: '触发次数',
	line: '动作',
	planned: '计划',
	syncedAt: '同步时间',
	managed: '托管',
	peakPlayers: '人数峰值',
	avgPlayers: '平均人数',
	minutes: '分钟',
	wins: '胜利',
	losses: '失败',
	riskScore: '风险分',
	scoreTick: '计分间隔',
	reserved: '免排队',
	config: '配置',
	message: '文案',
	messages: '文案',
	everyMinutes: '间隔分钟',
	onlyFirstVisit: '仅首次入服',
	afterFaction: '选阵营后发送',
	minPlayers: '最少人数',
	nextIndex: '下一项',
	nowIndex: '当前项',
	mode: '模式',
	pendingRestart: '待重启',
	effective: '生效',
	syncState: '同步状态',
	changed: '已修改'
};
/** Output only explicit presentation fields, never arbitrary config/raw/transport or credential values. */
export function managementView(value: unknown): string {
	if (Array.isArray(value) && !value.length) return '暂无记录';
	const lines: string[] = [];
	let rows = 0;
	const walk = (x: any, depth: number, configuration = false) => {
		if (lines.join('\n').length > 2600 || rows >= 18 || depth > 4) return;
		if (Array.isArray(x)) {
			for (const v of x.slice(0, 12)) {
				if (v && typeof v === 'object') {
					rows++;
					walk(v, depth + 1, configuration);
					lines.push('');
				} else lines.push(clean(v));
			}
			if (x.length > 12) lines.push(`另有 ${x.length - 12} 项，请在 Warcon 查看`);
			return;
		}
		if (x && typeof x === 'object') {
			for (const [k, v] of Object.entries(x)) {
				if (
					k === 'ok' ||
					k === 'caps' ||
					/password|secret|token|url|raw|text|detail|peer|image|endpoint/i.test(k)
				)
					continue;
				if (v && typeof v === 'object') {
					if (
						configuration ||
						labels[k] ||
						[
							'entries',
							'items',
							'records',
							'bans',
							'reserves',
							'maps',
							'lightings',
							'notes',
							'watch',
							'dossier',
							'stats',
							'risk',
							'matches',
							'analytics',
							'live',
							'population',
							'totals',
							'here',
							'serverEntries',
							'local',
							'lists',
							'summary',
							'result',
							'events'
						].includes(k)
					) {
						if (labels[k]) lines.push(labels[k] + '：');
						walk(v, depth + 1, configuration || k === 'config');
					}
				} else if ((configuration || labels[k]) && v !== null && v !== undefined)
					lines.push(
						(labels[k] || clean(k)) + '：' + (typeof v === 'boolean' ? (v ? '是' : '否') : clean(v))
					);
			}
			return;
		}
		if (x !== undefined && x !== null) lines.push(clean(x));
	};
	walk(value, 0);
	return (
		lines
			.filter((s, i, a) => s || a[i - 1])
			.join('\n')
			.trim()
			.slice(0, 2900) || '已读取，详细数据请在 Warcon 查看'
	);
}
export class ManagementClient implements ManagementPort {
	constructor(
		private servers: () => ManagedServer[],
		private factory: (s: ManagedServer) => WarconClient = (s) =>
			new WarconClient({ baseUrl: s.warconUrl, token: s.warconToken })
	) {}
	private connect(serverId: string) {
		const s = this.servers().find((x) => x.id === serverId);
		if (!s || !s.warconUrl || !s.warconToken)
			throw new ManagementInputError('请先在后台为此服务器配置 Warcon 管理连接');
		const sid = s.warconServerId || s.id;
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sid))
			throw new ManagementInputError('Warcon服务器ID无效');
		return { c: this.factory(s), base: '/api/servers/' + encodeURIComponent(sid), sid };
	}
	private async rules(serverId: string) {
		const { c, base } = this.connect(serverId);
		const r = await c.request(base + '/triggers', 'GET');
		if (!Array.isArray(r.triggers)) throw new Error('Invalid triggers');
		return r.triggers as Obj[];
	}
	private async plan(
		serverId: string,
		command: string,
		args: string,
		g: GroupConfig
	): Promise<RequestPlan> {
		const { c, base, sid } = this.connect(serverId);
		const def = MANAGEMENT_COMMANDS.find((x) => x.name === command);
		if (!def?.write) throw new ManagementInputError('不是可执行的管理命令');
		let path = '',
			method: RequestPlan['method'] = 'POST',
			body: Obj | undefined,
			version: unknown = null,
			summary = def.description + (args ? '\n' + clean(args) : '');
		const action = (name: string, p?: Obj) => {
			path = base + '/rcon/' + name;
			body = p ?? {};
		};
		const [a, b] = words(args);
		if (configFields[command]) {
			const spec = configFields[command];
			const value = spec.parse(args, g);
			const doc = await c.action(sid, 'config');
			if (
				typeof doc.text !== 'string' ||
				typeof doc.revision !== 'string' ||
				!doc.revision ||
				doc.writable === false
			)
				throw new ManagementInputError('游戏配置不可写或缺少版本号');
			version = doc.revision;
			action('configApply', {
				text: editConfigScalar(doc.text, spec.section, spec.key, value),
				revision: doc.revision
			});
			summary =
				def.description +
				'\n' +
				spec.key +
				' = ' +
				value +
				'\n将写入游戏配置，部分设置需下次重启生效' +
				(command === '每日重启' ? '\n时间为 UTC，游戏在重启窗口后的对局结束时重启' : '');
			return {
				method,
				path,
				body,
				expected: digest([command, args, version]),
				summary,
				config: { key: spec.key, value }
			};
		}
		switch (command) {
			case '公告':
				action('broadcast', { message: message(args) });
				break;
			case '私信':
				action('whisper', { steamId: steam(a), message: message(b) });
				break;
			case '阵营私信':
				if (!g.factions[a as '蓝']) throw new ManagementInputError('阵营填写 蓝、红 或 绿');
				action('whisperMany', { faction: g.factions[a as '蓝'], message: message(b) });
				break;
			case '踢出':
				action('kick', { steamId: steam(a), reason: message(b, 200) });
				break;
			case '重生':
				steam(args);
				action('kill', { steamId: args });
				break;
			case '强制换边':
				if (!g.factions[b as '蓝']) throw new ManagementInputError('阵营填写 蓝、红 或 绿');
				action('changeTeam', { steamId: steam(a), faction: g.factions[b as '蓝'] });
				break;
			case '封禁':
			case '添加免排队': {
				steam(a);
				const [duration, note] = words(b);
				const ms = expiry(duration);
				message(note, 200);
				path = base + '/lists/' + (command === '封禁' ? 'ban' : 'reserve') + '/entries';
				body = {
					steamId: a,
					reason: note,
					expiresAt: ms === null ? null : new Date(Date.now() + ms).toISOString()
				};
				break;
			}
			case '解除封禁':
			case '移除免排队': {
				steam(args);
				const state = await c.request(base + '/lists/state', 'GET');
				const entry = (state[command === '解除封禁' ? 'bans' : 'reserved'] as Obj)?.[args];
				if (!entry) throw new ManagementInputError('该玩家没有对应的名单记录');
				version = entry;
				if (entry.managed && entry.scope === 'org')
					throw new ManagementInputError('这是跨服务器共享名单，请在 Warcon 的共享名单中撤销');
				if (!entry.managed)
					action(command === '解除封禁' ? 'unban' : 'reservedRemove', { steamId: args });
				else {
					method = 'DELETE';
					path =
						base + '/lists/' + (command === '解除封禁' ? 'ban' : 'reserve') + '/entries/' + args;
				}
				break;
			}
			case '关注':
			case '取消关注':
				steam(a);
				if (command === '关注') message(b, 500);
				else if (b) throw new ManagementInputError('取消关注只需SteamID');
				method = 'PUT';
				path = base + '/players/' + a + '/watch';
				body = { watched: command === '关注', reason: b };
				break;
			case '备注':
				steam(a);
				path = base + '/players/' + a + '/notes';
				body = { body: message(b, 1000) };
				break;
			case '结束对局':
			case '重开对局':
				if (args) throw new ManagementInputError('该命令不需要参数');
				action(command === '结束对局' ? 'endMatch' : 'restartMatch');
				break;
			case '切图':
			case '下一张':
			case '轮换添加':
				action(
					{ 切图: 'changeMap', 下一张: 'setNextMap', 轮换添加: 'rotationAdd' }[command],
					selection(args)
				);
				break;
			case '天气':
				action('setWeather', { lighting: id(args) });
				break;
			case '轮换删除':
			case '轮换上移':
			case '轮换下移': {
				const index = integer(args, 1, 10000) - 1;
				version = await c.action(sid, 'rotation');
				action(command === '轮换删除' ? 'rotationRemove' : 'rotationMove', {
					index,
					...(command === '轮换删除' ? {} : { direction: command === '轮换上移' ? 'up' : 'down' })
				});
				break;
			}
			case '轮换保存':
				if (args) throw new ManagementInputError('轮换保存不需要参数');
				action('rotationSave');
				break;
			case '轮换模式':
				if (!['顺序', '随机'].includes(args))
					throw new ManagementInputError('轮换模式填写 顺序 或 随机');
				action('rotationSettings', { rotationMode: args === '随机' ? 'random' : 'ordered' });
				break;
			case '轮换开关':
				action('rotationSettings', { rotationEnabled: onOff(args) });
				break;
			case '计分间隔':
				action('settings', { scoreTick: integer(args, 1, 600) });
				break;
			case '欢迎私信':
			case '欢迎开关': {
				const rules = await this.rules(serverId);
				const welcomes = rules.filter((x) => x.kind === 'welcome');
				if (welcomes.length > 1)
					throw new ManagementInputError(
						'存在多条欢迎规则，请用 /规则详情 和 /规则修改 指定规则ID'
					);
				const existing = welcomes[0];
				version = existing
					? { id: existing.id, config: existing.config, enabled: existing.enabled }
					: null;
				if (command === '欢迎开关') {
					if (!existing) throw new ManagementInputError('请先用 /欢迎私信 内容 创建规则');
					path = base + '/triggers/' + id(existing.id);
					method = 'PATCH';
					body = { enabled: onOff(args) };
				} else {
					if (!args) throw new ManagementInputError('用法：/欢迎私信 内容，查看请用 /欢迎设置');
					message(args);
					path = base + '/triggers' + (existing ? '/' + id(existing.id) : '');
					method = existing ? 'PATCH' : 'POST';
					body = existing
						? { config: { ...existing.config, message: args } }
						: {
								kind: 'welcome',
								name: '入服欢迎私信',
								enabled: true,
								config: { message: args, onlyFirstVisit: false, afterFaction: false }
							};
				}
				break;
			}
			case '定时公告':
				path = base + '/triggers';
				body = {
					kind: 'broadcast',
					name: '定时公告',
					enabled: true,
					config: {
						messages: [message(b)],
						everyMinutes: integer(a, 1, 1440),
						minPlayers: 1,
						maxPlayers: null
					}
				};
				break;
			case '规则创建': {
				id(a);
				let config: unknown;
				try {
					config = JSON.parse(b);
				} catch {
					throw new ManagementInputError('配置需为JSON对象');
				}
				if (!config || typeof config !== 'object' || Array.isArray(config))
					throw new ManagementInputError('配置需为JSON对象');
				path = base + '/triggers';
				body = { kind: a, name: a + ' · QQ', enabled: false, config };
				summary += '\n新规则默认停用，核对后使用 /规则启用';
				break;
			}
			case '规则启用':
			case '规则停用':
			case '规则删除':
			case '规则修改': {
				const ruleId = id(a);
				const rules = await this.rules(serverId);
				const r = rules.find((x) => x.id === ruleId);
				if (!r) throw new ManagementInputError('未找到该规则ID');
				version = { id: r.id, kind: r.kind, config: r.config, enabled: r.enabled };
				path = base + '/triggers/' + ruleId;
				method = command === '规则删除' ? 'DELETE' : 'PATCH';
				if (command === '规则修改') {
					let config: unknown;
					try {
						config = JSON.parse(b);
					} catch {
						throw new ManagementInputError('配置需为JSON对象');
					}
					if (!config || typeof config !== 'object' || Array.isArray(config))
						throw new ManagementInputError('配置需为JSON对象');
					body = { config };
				} else {
					if (b) throw new ManagementInputError('该命令只需要规则ID');
					if (method !== 'DELETE') body = { enabled: command === '规则启用' };
				}
				break;
			}
			default:
				throw new ManagementInputError('未实现的管理命令');
		}
		// Expiry is computed again at dispatch, not part of the resource concurrency token.
		return { path, method, body, expected: digest([command, args, version]), summary };
	}
	async prepare(serverId: string, command: string, args: string, g: GroupConfig) {
		const p = await this.plan(serverId, command, args, g);
		return { expected: p.expected, summary: p.summary };
	}
	async execute(
		serverId: string,
		command: string,
		args: string,
		g: GroupConfig,
		expected: string,
		guard: () => void
	) {
		const p = await this.plan(serverId, command, args, g);
		if (p.expected !== expected) throw new ManagementInputError('目标配置已变化');
		const { c, base, sid } = this.connect(serverId);
		guard();
		const result = await c.request(p.path, p.method, p.body);
		if (p.path.endsWith('/rcon/configApply')) {
			const outcome = result.result as Obj;
			if (!outcome?.ok) {
				if (outcome?.conflict) throw new ManagementInputError('配置版本已变化');
				throw new Error('Config not confirmed');
			}
			const spec = configFields[command];
			const after = await c.action(sid, 'config');
			if (
				typeof after.text !== 'string' ||
				configScalar(after.text, spec.section, spec.key) !== p.config!.value
			)
				throw new Error('Config readback mismatch');
			return (
				'已保存 ' +
				spec.key +
				' = ' +
				p.config!.value +
				'\n部分设置需下次重启生效，未强制结束当前对局'
			);
		}
		if (
			command === '封禁' ||
			command === '添加免排队' ||
			command === '解除封禁' ||
			command === '移除免排队'
		)
			return '已更新托管名单\n实际生效情况请用 /封禁列表 或 /免排队列表 核对';
		const label = MANAGEMENT_COMMANDS.find((x) => x.name === command)!.description;
		return (
			'已提交并收到 Warcon 确认：' +
			label +
			'\n' +
			managementView(result.result ?? result.trigger ?? result.note ?? {})
		);
	}
	async read(serverId: string, command: string, args: string, g: GroupConfig): Promise<string> {
		const { c, base, sid } = this.connect(serverId);
		const action = (name: string, p?: Obj) => c.action(sid, name, p);
		switch (command) {
			case '在线玩家': {
				const page = args ? integer(args, 1, 100) : 1;
				const r = await action('players');
				if (!Array.isArray(r.players)) throw new Error();
				const start = (page - 1) * 10;
				return (
					`在线玩家 ${r.players.length} · 第${page}页\n` +
					r.players
						.slice(start, start + 10)
						.map(
							(p: any, i: number) =>
								`${start + i + 1}. ${clean(p.name)} · ${clean(p.faction)}\n${clean(p.steamId)} · K ${clean(p.kills)} / D ${clean(p.deaths)} · ${clean(p.ping)}ms`
						)
						.join('\n')
				);
			}
			case '地图列表':
				return managementView((await action('maps')).maps);
			case '模式列表':
				return managementView((await action('experiences', { map: id(args) })).experiences);
			case '天气列表':
				return managementView((await action('lightings')).lightings);
			case '轮换列表':
				return managementView(await action('rotation'));
			case '封禁列表':
			case '免排队列表': {
				const state = await c.request(base + '/lists/state', 'GET');
				const entries = state[command === '封禁列表' ? 'bans' : 'reserved'];
				return managementView(
					Object.entries((entries as Obj) ?? {}).map(([steamId, v]) => ({ steamId, ...(v as Obj) }))
				);
			}
			case '玩家档案':
				return managementView(await c.request(base + '/players/' + steam(args), 'GET'));
			case '近期对局':
				return managementView(await c.request(base + '/matches', 'GET'));
			case '运营概览':
				if (args && !['24h', '7d', '30d'].includes(args))
					throw new ManagementInputError('范围为 24h、7d 或 30d');
				return managementView(await c.request(base + '/analytics?range=' + (args || '24h'), 'GET'));
			case '规则列表':
				return managementView(
					(await this.rules(serverId)).map((x) => ({
						id: x.id,
						name: x.name,
						kind: x.kind,
						enabled: x.enabled
					}))
				);
			case '规则详情': {
				const r = (await this.rules(serverId)).find((x) => x.id === id(args));
				return r
					? managementView({
							id: r.id,
							name: r.name,
							kind: r.kind,
							enabled: r.enabled,
							config: r.config
						})
					: '没有找到该规则';
			}
			case '欢迎设置':
				return managementView(
					(await this.rules(serverId))
						.filter((x) => x.kind === 'welcome')
						.map((x) => ({ id: x.id, name: x.name, enabled: x.enabled, config: x.config }))
				);
			case '规则执行记录':
				return managementView(await c.request(base + '/outbox', 'GET'));
			case '审计记录':
				return managementView(
					await c.request('/api/audit?server=' + encodeURIComponent(sid), 'GET')
				);
			case '规则试运行': {
				const r = (await this.rules(serverId)).find((x) => x.id === id(args));
				if (!r) throw new ManagementInputError('没有找到该规则');
				const result = await c.request(base + '/triggers/dry-run', 'POST', {
					kind: r.kind,
					config: r.config
				});
				return '只预演，未执行游戏操作\n' + managementView(result);
			}
			case '重启计划': {
				const [doc, status] = await Promise.all([
					action('config'),
					c.request(base + '/summary', 'GET')
				]);
				const configured =
					typeof doc.text === 'string' ? configScalar(doc.text, lifecycle, 'RestartTimeUtc') : null;
				const live = (status.live ?? {}) as Obj;
				return (
					'配置中的每日重启：' +
					(configured ? configured + ' UTC' : '未设置，游戏默认运行24小时后于对局结束时重启') +
					'\n运行中重启时间：' +
					clean(live.restartTimeUtc ?? '请在 Warcon 设置页核对') +
					'\n修改 RestartTimeUtc 后可能需下次重启才由游戏读取'
				);
			}
			default:
				throw new ManagementInputError('未知管理查询');
		}
	}
}
