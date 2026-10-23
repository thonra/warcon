export interface ReplyDefinition {
	label: string;
	category: string;
	text: string;
	variables: string[];
	required: string[];
	allowEmpty: boolean;
}
const entry = (
	label: string,
	category: string,
	text: string,
	variables: string[] = [],
	required: string[] = [],
	allowEmpty = false
): ReplyDefinition => ({ label, category, text, variables, required, allowEmpty });

export const REPLY_CATALOG = {
	'admin.denied': entry('无管理权限', '管理', '无管理权限'),
	'admin.failed': entry(
		'管理查询异常',
		'管理',
		'管理请求未完成，请核对 圣女千夜的教堂 管理连接、权限或稍后重试'
	),
	'admin.changed': entry('管理配置变化', '管理', '配置已变化或命令已过期，请重新发送'),
	'admin.identity': entry(
		'管理身份关联',
		'管理',
		'身份码 {code}\n请由后台管理员核对你的QQ身份后，在管理权限中关联\n10分钟内有效，这一步不会授予管理权限',
		['code'],
		['code']
	),
	'admin.help': entry(
		'管理员帮助',
		'管理',
		'{commands}\n发送 /管理帮助 分类 查看参数示例\n写操作需在2分钟内使用 /执行 确认，不会自动重试',
		['commands'],
		['commands']
	),
	'admin.quote': entry(
		'管理操作确认',
		'管理',
		'{serverName}\n{summary}\n请核对目标与影响，2分钟内发送 /执行 {code}\n取消请发送 /取消管理 {code}',
		['serverName', 'summary', 'code'],
		['summary', 'code']
	),
	'admin.success': entry(
		'管理操作完成',
		'管理',
		'{result}\n记录：{orderId}',
		['result', 'orderId'],
		['result', 'orderId']
	),
	'admin.unknown': entry(
		'管理结果待核实',
		'管理',
		'操作结果暂不确定，请在 圣女千夜的教堂 核实\n不会自动重复执行，请勿直接重复提交\n记录：{orderId}',
		['orderId'],
		['orderId']
	),
	'help.title': entry('帮助标题', '帮助', '{serverName} · 自助服务', ['serverName']),
	'help.commands': entry('帮助命令列表', '帮助', '{commands}', ['commands']),
	'help.economy': entry(
		'帮助中的积分规则',
		'帮助',
		'每日签到 +{points} 积分（{timezone}）；换边 {cost} 积分，冷却 {cooldown} 秒',
		['points', 'timezone', 'cost', 'cooldown']
	),
	'help.footer': entry(
		'帮助说明',
		'帮助',
		'换边会让游戏角色重新部署，需再次确认\n绑定与积分由同一社区的群共享\n请勿把游戏验证码交给他人',
		[],
		[],
		true
	),
	'group.suffix': entry('群回复附加文字', '通用', '', [], [], true),
	'private.wrapper': entry(
		'私聊回复格式',
		'通用',
		'{serverName} · 私聊测试\n{reply}',
		['serverName', 'reply'],
		['reply']
	),
	'command.unknown': entry(
		'未知命令',
		'通用',
		'没有识别到这个命令\n发送 /使用帮助 查看菜单，例如 /签到、/查对局、/换边 蓝'
	),
	'command.failed': entry(
		'操作异常',
		'通用',
		'暂时无法完成操作，请稍后再试\n若涉及换边，可用 /积分 查看状态；请勿连续重复操作'
	),
	'command.unauthorized': entry('群组未授权', '通用', '当前群组未授权使用这个服务器'),
	'command.changed': entry('配置已更新', '通用', '机器人配置已更新，请重新发送命令'),
	'server.stale': entry('服务器状态过期', '对局', '服务器状态已过期，暂时无法操作\n请稍后重试'),
	'server.summary': entry(
		'服务器状态格式',
		'对局',
		'{serverName} · {map}\n在线 {playerCount}/{maxPlayers}\n{scores}',
		['serverName', 'map', 'playerCount', 'maxPlayers', 'scores']
	),
	'match.player': entry(
		'个人战绩格式',
		'对局',
		'{playerName} · {faction}\n击杀 {kills} / 死亡 {deaths} / 延迟 {ping} ms',
		['playerName', 'faction', 'kills', 'deaths', 'ping']
	),
	'bind.required': entry(
		'尚未绑定',
		'绑定',
		'请先发送 /绑定 你的SteamID64（17位数字），进入服务器后按游戏内私信完成验证'
	),
	'bind.usage': entry(
		'绑定用法',
		'绑定',
		'用法：/绑定 你的SteamID64\nSteamID64 是 17 位数字\n请先进入本群对应的游戏服务器'
	),
	'bind.already': entry('已经绑定', '绑定', '你已经绑定了 Steam 账号\n更换绑定请联系管理员'),
	'bind.offline': entry(
		'找不到待绑定玩家',
		'绑定',
		'没有在服务器中找到这个 Steam 账号\n请先进入本群对应的服务器，再发送绑定命令'
	),
	'bind.uncertain': entry(
		'验证码发送待核实',
		'绑定',
		'游戏内验证码发送结果暂不确定\n如果已收到，请在5分钟内发送 /验证 验证码；否则请一分钟后重新申请\n验证码不会在QQ群展示'
	),
	'bind.sent': entry(
		'验证码已发送',
		'绑定',
		'已向游戏中的 {playerName} 发送绑定验证码，请在5分钟内发送 /验证 6位验证码\n验证码只在游戏内展示',
		['playerName']
	),
	'bind.verifyUsage': entry(
		'验证用法',
		'绑定',
		'用法：/验证 6位验证码\n请使用刚刚在游戏内私信中收到的验证码'
	),
	'bind.success': entry(
		'绑定成功',
		'绑定',
		'绑定成功：{steamId}\n现在可以 /签到、/积分、/查对局 或 /换边 蓝',
		['steamId']
	),
	'bind.used': entry('Steam 账号已被绑定', '绑定', '这个 Steam 账号已被绑定，请联系管理员核实'),
	'bind.limited': entry(
		'验证码申请冷却',
		'绑定',
		'验证码已发送，请查看游戏内私信\n每分钟最多申请一次'
	),
	'bind.completed': entry('无需重复验证', '绑定', '你已经完成绑定，无需重复验证'),
	'bind.expired': entry('验证码过期', '绑定', '验证码不存在或已过期\n请先发送 /绑定 你的SteamID64'),
	'bind.attempts': entry('验证码失败过多', '绑定', '验证失败次数过多，请等待一分钟后重新 /绑定'),
	'bind.wrong': entry(
		'验证码错误',
		'绑定',
		'验证码不正确，还可尝试 {remaining} 次\n请查看游戏内私信，不要使用其他人的验证码',
		['remaining']
	),
	'bind.other': entry('其他账号已绑定', '绑定', '这个 Steam 账号已被其他人绑定，请联系管理员核实'),
	'bind.checkinRequired': entry(
		'签到前需要绑定',
		'签到',
		'请先 /绑定 你的SteamID64，并在游戏内完成验证码验证'
	),
	'checkin.success': entry(
		'签到成功',
		'签到',
		'签到成功！+{points} 积分，当前余额 {balance}\n签到日期：{day}（{timezone}）',
		['points', 'balance', 'day', 'timezone']
	),
	'checkin.already': entry(
		'今日已经签到',
		'签到',
		'今天已经签到过啦，当前余额 {balance} 积分\n次日零点可再次签到（{timezone}）',
		['balance', 'timezone']
	),
	'points.limit': entry('积分余额限制', '积分', '积分不足，或积分余额已达到上限'),
	'points.summary': entry('积分摘要', '积分', '积分余额：{balance}', ['steamId', 'balance']),
	'points.pending': entry(
		'换边暂扣信息',
		'积分',
		'换边暂扣：{cost} 积分；{state}\n订单：{orderId}',
		['cost', 'state', 'orderId']
	),
	'reserved.active': entry('免排队已配置', '积分', '免排队：名单已配置；{expiry}', ['expiry']),
	'reserved.none': entry('没有免排队', '积分', '免排队：当前没有有效名额'),
	'reserved.pending': entry('免排队同步中', '积分', '免排队：名单同步中，尚未确认生效'),
	'reserved.unknown': entry('免排队状态未知', '积分', '免排队：状态暂不可用，请联系管理员确认'),
	'reserved.failed': entry('免排队查询失败', '积分', '免排队：暂时查询失败，积分余额不受影响'),
	'match.offline': entry('玩家不在服务器', '对局', '你目前不在这个服务器中'),
	'move.disabled': entry(
		'服务器未开放换边',
		'换边',
		'当前服务器未开放机器人换边，或机器人账号没有换边权限'
	),
	'move.mapping': entry(
		'阵营映射不匹配',
		'换边',
		'本群的阵营映射与当前对局不匹配，请管理员检查配置后重试'
	),
	'move.offline': entry(
		'换边前需进入服务器',
		'换边',
		'你目前不在本群对应的游戏服务器中\n请进入服务器后再试'
	),
	'move.same': entry('已经在目标阵营', '换边', '你已经在 {faction} 阵营，无需换边，也不会扣积分', [
		'faction'
	]),
	'move.usage': entry(
		'换边用法',
		'换边',
		'用法：/换边 蓝（或红、绿）\n也支持 /换边蓝、/换边红、/换边绿'
	),
	'move.insufficient': entry(
		'换边积分不足',
		'换边',
		'积分不足：换边需要 {cost}，当前余额 {balance}\n可以通过 /签到 获取积分',
		['cost', 'balance']
	),
	'move.quote': entry(
		'换边报价与确认',
		'换边',
		'准备换到{color}方 {faction}，费用 {cost} 积分（当前 {balance}）\n角色会重新部署，可能丢失当前装备；换边后冷却 {cooldown} 秒\n如确认，请在2分钟内发送 /确认 {code}；不回复即取消',
		['color', 'faction', 'cost', 'balance', 'cooldown', 'code'],
		['faction', 'cost', 'code']
	),
	'move.success': entry(
		'换边成功',
		'换边',
		'换边指令已成功执行：{faction}，扣除 {cost} 积分\n当前余额 {balance}',
		['faction', 'cost', 'balance']
	),
	'move.refunded': entry(
		'换边未执行并退分',
		'换边',
		'换边未执行，{cost} 积分已退回\n可重新发送换边命令',
		['cost']
	),
	'move.running': entry('换边处理中', '换边', '换边正在处理，请稍候\n重复确认不会再次扣分或执行'),
	'move.unknown': entry(
		'换边结果待核实',
		'换边',
		'换边结果暂不确定，{cost} 积分已暂扣\n请联系管理员核实订单 {orderId}\n系统不会自动重复换边或退款',
		['cost', 'orderId'],
		['orderId']
	),
	'move.confirmUsage': entry(
		'确认用法',
		'换边',
		'用法：/确认 6位确认码\n请使用机器人给你的最新换边确认码'
	),
	'move.changed': entry('换边规则已更新', '换边', '换边费用或阵营配置已更新，请重新发送换边命令'),
	'move.previousUnknown': entry(
		'上一笔换边待核实',
		'换边',
		'上一笔换边结果待管理员核实，已暂时锁定后续换边\n订单：{orderId}\n积分暂扣，不会重复执行',
		['orderId'],
		['orderId']
	),
	'move.previousRunning': entry('上一笔换边处理中', '换边', '上一笔换边正在处理，请稍候'),
	'move.cooldown': entry('换边冷却中', '换边', '换边冷却中，请 {seconds} 秒后再试', ['seconds']),
	'move.noConfirmation': entry(
		'找不到有效确认码',
		'换边',
		'没有找到你的有效确认码\n请先发送 /换边 蓝（或红、绿）'
	),
	'move.expired': entry('确认已过期', '换边', '换边确认已过期，请重新发送换边命令'),
	'move.replaced': entry('确认码已被替换', '换边', '确认已被新的换边请求替代，请使用最新确认码'),
	'move.bindingChanged': entry('绑定信息变化', '换边', '绑定信息已变化，请重新发起换边'),
	'cancel.success': entry(
		'取消成功',
		'通用',
		'已取消待验证绑定和未确认的换边，不会扣除积分\n已执行或待核实的操作不受影响'
	),
	'cancel.none': entry(
		'没有待取消请求',
		'通用',
		'没有待取消的请求\n已执行或待核实的换边请用 /积分 查询，或联系管理员'
	),
	'transport.incomplete': entry(
		'处理未完成',
		'通用',
		'处理未完成，请查询 /积分；涉及换边时请联系管理员核对，勿重复提交'
	),
	'transport.disabled': entry('会话接入已停用', '通用', '该会话接入已停用'),
	'transport.changed': entry('接入配置已更新', '通用', '配置已更新，请重新发送命令'),
	'transport.expired': entry('命令超时', '通用', '命令已超过两分钟，请重新发送')
} as const;
export type ReplyKey = keyof typeof REPLY_CATALOG;
export type ReplyOverrides = Partial<Record<ReplyKey, string>>;
export type ReplyValues = Record<string, string | number>;
export class ReplyValidationError extends Error {}
export function validateReplies(raw: unknown): ReplyOverrides {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		throw new ReplyValidationError('文案配置格式无效');
	const out: ReplyOverrides = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!Object.hasOwn(REPLY_CATALOG, key)) throw new ReplyValidationError('包含未知文案项');
		const definition: ReplyDefinition = REPLY_CATALOG[key as ReplyKey];
		if (
			typeof value !== 'string' ||
			value.length > 2000 ||
			/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ||
			(!definition.allowEmpty && !value.trim())
		)
			throw new ReplyValidationError(definition.label + '需为1至2000字的文本');
		const text = value.replace(/\r\n/g, '\n');
		const variables = [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
		if (
			variables.some((v) => !definition.variables.includes(v)) ||
			/[{}]/.test(text.replace(/\{[^{}]*\}/g, ''))
		)
			throw new ReplyValidationError(definition.label + '包含不支持的变量');
		if (definition.required.some((v) => !variables.includes(v)))
			throw new ReplyValidationError(
				definition.label + '需保留变量 ' + definition.required.map((v) => '{' + v + '}').join('、')
			);
		if (key === 'admin.quote' && !text.includes('/执行 {code}'))
			throw new ReplyValidationError('管理确认需保留 /执行 {code}');
		if (key === 'move.quote' && !text.includes('发送 /确认 {code}'))
			throw new ReplyValidationError('换边报价需保留 发送 /确认 {code}');
		if (text !== definition.text) out[key as ReplyKey] = text;
	}
	return out;
}
export function renderReply(
	key: ReplyKey,
	values: ReplyValues = {},
	overrides: ReplyOverrides = {}
): string {
	return (overrides[key] ?? REPLY_CATALOG[key].text).replace(
		/\{([a-zA-Z][a-zA-Z0-9]*)\}/g,
		(_, name: string) => String(values[name] ?? '')
	);
}
export function groupReply(reply: string, overrides: ReplyOverrides = {}): string {
	const suffix = renderReply('group.suffix', {}, overrides);
	return suffix ? reply + '\n' + suffix : reply;
}
