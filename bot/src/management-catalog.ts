/** Hidden staff command registry; deliberately separate from public commands and QQ menus. */
export interface ManagementCommand {
	name: string;
	usage: string;
	category: string;
	write: boolean;
	description: string;
}
const defs: [string, string, string, boolean, string][] = [
	['在线玩家', '[页码]', '查询', false, '在线玩家、SteamID 和阵营'],
	['地图列表', '', '查询', false, '可用地图 ID'],
	['模式列表', '地图ID', '查询', false, '地图支持的模式'],
	['天气列表', '', '查询', false, '可用光照 ID'],
	['轮换列表', '', '查询', false, '当前地图轮换'],
	['封禁列表', '', '查询', false, '封禁和托管状态'],
	['免排队列表', '', '查询', false, '免排队和同步状态'],
	['玩家档案', 'SteamID', '查询', false, '战绩、风险、备注和关注'],
	['近期对局', '', '查询', false, '最近对局'],
	['运营概览', '24h|7d|30d', '查询', false, '人数与对局分析'],
	['规则列表', '', '自动化', false, '已有规则 ID 与开关'],
	['规则详情', '规则ID', '自动化', false, '规则配置'],
	['规则执行记录', '', '自动化', false, '自动化近期执行结果'],
	['审计记录', '', '查询', false, 'Warcon 近期审计'],
	['管理记录', '', '查询', false, '机器人管理操作记录'],
	['公告', '内容', '消息', true, '向服务器广播'],
	['私信', 'SteamID 内容', '消息', true, '向指定玩家 whisper'],
	['阵营私信', '蓝|红|绿 内容', '消息', true, '向对应阵营 whisper'],
	['踢出', 'SteamID 理由', '玩家', true, '踢出在线玩家'],
	['重生', 'SteamID', '玩家', true, '让玩家角色重新部署'],
	['强制换边', 'SteamID 蓝|红|绿', '玩家', true, '管理员换边，不使用玩家积分'],
	['封禁', 'SteamID 7d|永久 理由', '玩家', true, '服务器托管封禁，支持到期'],
	['解除封禁', 'SteamID', '玩家', true, '撤销服务器托管封禁'],
	['添加免排队', 'SteamID 7d|永久 备注', '玩家', true, '添加托管名额，支持到期'],
	['移除免排队', 'SteamID', '玩家', true, '撤销服务器托管名额'],
	['关注', 'SteamID 理由', '玩家', true, '加入 Warcon 关注名单'],
	['取消关注', 'SteamID', '玩家', true, '移出关注名单'],
	['备注', 'SteamID 内容', '玩家', true, '添加玩家备注'],
	['结束对局', '', '对局', true, '结束当前对局'],
	['重开对局', '', '对局', true, '重新开始当前对局'],
	['切图', '地图ID [模式=ID,ID] [光照=ID] [区域=ID]', '对局', true, '立即切换地图'],
	['下一张', '地图ID [模式=ID,ID] [光照=ID] [区域=ID]', '对局', true, '设置下一张地图'],
	['天气', '光照ID', '对局', true, '切换光照'],
	['轮换添加', '地图ID [模式=ID,ID] [光照=ID] [区域=ID]', '轮换', true, '添加地图轮换项'],
	['轮换删除', '序号', '轮换', true, '删除轮换项，序号从1开始'],
	['轮换上移', '序号', '轮换', true, '上移一项'],
	['轮换下移', '序号', '轮换', true, '下移一项'],
	['轮换保存', '', '轮换', true, '保存当前轮换'],
	['轮换模式', '顺序|随机', '轮换', true, '更改轮换模式'],
	['轮换开关', '开|关', '轮换', true, '启用或停用轮换'],
	['计分间隔', '1至600', '配置', true, '修改实时计分间隔'],
	['服务器名称', '名称', '配置', true, '修改游戏服务器名称'],
	['人数上限', '人数', '配置', true, '修改配置中的玩家上限'],
	['保留槽位', '人数', '配置', true, '修改预留给免排队的槽位数'],
	['重启计划', '', '配置', false, '查看运行中与配置中的重启时间'],
	['每日重启', 'HH:MM [UTC|UTC+08:00|Asia/Shanghai]', '配置', true, '设置每日重启时间'],
	['恢复默认重启', '', '配置', true, '清空每日时间，恢复游戏24小时策略'],
	['欢迎私信', '[内容]', '自动化', true, '设置入服 whisper，支持 {name} 等变量'],
	['欢迎设置', '', '自动化', false, '查看入服 whisper'],
	['欢迎开关', '开|关', '自动化', true, '启用或停用欢迎私信'],
	['定时公告', '分钟数 内容', '自动化', true, '创建循环广播规则'],
	['规则启用', '规则ID', '自动化', true, '启用现有规则'],
	['规则停用', '规则ID', '自动化', true, '停用现有规则'],
	['规则删除', '规则ID', '自动化', true, '删除现有规则'],
	['规则创建', '类型 JSON配置', '自动化', true, '高级：创建已有类型规则，默认停用'],
	['规则修改', '规则ID JSON配置', '自动化', true, '高级：修改已有规则配置'],
	['规则试运行', '规则ID', '自动化', false, '只预演，不执行游戏操作'],
	['管理帮助', '[分类]', '管理', false, '仅管理员可见的命令列表'],
	['执行', '8位确认码', '管理', false, '确认自己的待执行操作'],
	['取消管理', '8位确认码', '管理', false, '取消自己的待确认操作']
];
export const MANAGEMENT_COMMANDS: ManagementCommand[] = defs.map(
	([name, usage, category, write, description]) => ({ name, usage, category, write, description })
);
export const MANAGEMENT_NAMES = new Set([...MANAGEMENT_COMMANDS.map((x) => x.name), '管理身份']);
export function managementInput(text: string) {
	const m = text
		.trim()
		.replace(/^／/, '/')
		.match(/^\/?([^\s]+)(?:\s+([\s\S]*))?$/);
	return m && MANAGEMENT_NAMES.has(m[1]) ? { name: m[1], args: (m[2] ?? '').trim() } : null;
}
