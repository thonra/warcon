import { randomInt } from 'node:crypto';
import {
	WarconError,
	type BotHandler,
	type BotMessage,
	type GameSnapshot,
	type GroupConfig,
	type TeamColor,
	type WarconPort
} from './contracts';
import { BotStore, BotUserError, type Binding, type MoveOperation } from './store';

const BIND_HELP = '请先发送 /绑定 你的SteamID64（17位数字），进入服务器后按游戏内私信完成验证。';
const cleanName = (name: string) => name.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 80);
function dayInZone(now: number, timezone: string) {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(new Date(now));
	return ['year', 'month', 'day']
		.map((type) => parts.find((part) => part.type === type)!.value)
		.join('-');
}
function formatTime(value: string, timezone: string) {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return '到期时间暂不可用';
	return new Intl.DateTimeFormat('zh-CN', {
		timeZone: timezone,
		dateStyle: 'medium',
		timeStyle: 'short'
	}).format(date);
}
interface CommandDefinition {
	aliases: readonly string[];
	usage: string;
	description: string;
	run: (message: BotMessage, group: GroupConfig, argument: string) => Promise<string> | string;
}

/** Transport-independent Chinese commands. All privileged targets come from verified bindings. */
export class CommandHandler implements BotHandler {
	private readonly now: () => number;
	private readonly code: () => string;
	private readonly configurationRevision?: () => string | undefined;
	private readonly commands: CommandDefinition[];
	constructor(
		private readonly store: BotStore,
		private readonly warcon: WarconPort,
		options: {
			now?: () => number;
			code?: () => string;
			configurationRevision?: () => string | undefined;
		} = {}
	) {
		this.now = options.now ?? Date.now;
		this.configurationRevision = options.configurationRevision;
		this.code = options.code ?? (() => randomInt(0, 1_000_000).toString().padStart(6, '0'));
		// Register aliases, help, and dispatch together so new commands cannot drift from the menu.
		this.commands = [
			{
				aliases: ['使用帮助', '帮助', 'help'],
				usage: '使用帮助',
				description: '查看全部命令（也可以用 /帮助）',
				run: (_, group) => this.help(group)
			},
			{
				aliases: ['绑定'],
				usage: '绑定 SteamID64',
				description: '游戏内验证码验证，防止冒领',
				run: (message, group, argument) => this.bind(message, group, argument)
			},
			{
				aliases: ['验证'],
				usage: '验证 6位验证码',
				description: '完成自己的 Steam 账号绑定',
				run: (message, group, argument) => this.verify(message, group, argument)
			},
			{
				aliases: ['签到'],
				usage: '签到',
				description: '每日领取积分',
				run: (message, group) => this.checkin(message, group)
			},
			{
				aliases: ['积分'],
				usage: '积分',
				description: '积分余额、免排队名单状态',
				run: (message, group) => this.points(message, group)
			},
			{
				aliases: ['服务器'],
				usage: '服务器',
				description: '在线人数、地图、各阵营分数',
				run: async (message, group) => {
					const snapshot = await this.freshSnapshot(message, group);
					this.assertCurrentConfiguration(message);
					return this.renderSnapshot(snapshot, group);
				}
			},
			{
				aliases: ['查对局'],
				usage: '查对局',
				description: '当前对局和自己的战绩',
				run: (message, group) => this.match(message, group)
			},
			{
				aliases: ['换边'],
				usage: '换边 蓝 / 红 / 绿',
				description: '查看费用并确认换边；支持 /换边蓝',
				run: (message, group, argument) => this.quoteMove(message, group, argument)
			},
			{
				aliases: ['确认'],
				usage: '确认 6位确认码',
				description: '确认自己的待处理换边',
				run: (message, group, argument) => this.confirmMove(message, group, argument)
			}
		];
	}
	async handle(message: BotMessage, group: GroupConfig): Promise<string> {
		if (message.groupId !== group.groupId || !message.userId || !message.id)
			return '当前群组未授权使用这个服务器。';
		try {
			this.assertCurrentConfiguration(message);
			const text = message.text.trim().replace(/^／/, '/');
			const match = text.match(/^\/?([^\s]+)(?:\s+([\s\S]*))?$/);
			if (!match) return this.help(group);
			let command = match[1];
			let argument = (match[2] ?? '').trim();
			if (/^换边[蓝红绿]$/.test(command)) {
				argument = command.slice(-1);
				command = '换边';
			}
			const definition = this.commands.find((entry) => entry.aliases.includes(command));
			if (!definition)
				return '没有识别到这个命令。发送 /使用帮助 查看菜单，例如 /签到、/查对局、/换边 蓝。';
			return await definition.run(message, group, argument);
		} catch (error) {
			if (error instanceof BotUserError) return error.message;
			// Never echo transport errors: they can contain URLs, credentials or raw responses.
			return '暂时无法完成操作，请稍后再试。若涉及换边，可用 /积分 查看状态；请勿连续重复操作。';
		}
	}
	private assertCurrentConfiguration(message: BotMessage) {
		if (
			this.configurationRevision &&
			message.configurationRevision !== this.configurationRevision()
		)
			throw new BotUserError('机器人配置已更新，请重新发送命令。');
	}
	private help(group: GroupConfig) {
		return [
			`${group.serverName} · 自助服务`,
			...this.commands.map(({ usage, description }) => `/${usage} — ${description}`),
			'',
			`每日签到 +${group.checkinPoints} 积分（${group.timezone}）；换边 ${group.moveCost} 积分，冷却 ${group.moveCooldownSeconds} 秒。`,
			'换边会让游戏角色重新部署，需再次确认。绑定与积分由同一社区的群共享。请勿把游戏验证码交给他人。'
		].join('\n');
	}
	private requireBinding(message: BotMessage, group: GroupConfig): Binding {
		const binding = this.store.binding(group.communityId, message.userId);
		if (!binding) throw new BotUserError(BIND_HELP);
		return binding;
	}
	private async freshSnapshot(message: BotMessage, group: GroupConfig): Promise<GameSnapshot> {
		const snapshot = await this.warcon.snapshot(group.serverId);
		this.assertCurrentConfiguration(message);
		if (
			!Number.isFinite(snapshot.observedAt) ||
			snapshot.observedAt < this.now() - 15_000 ||
			snapshot.observedAt > this.now() + 5_000
		)
			throw new BotUserError('服务器状态已过期，暂时无法操作。请稍后重试。');
		return snapshot;
	}
	private async bind(message: BotMessage, group: GroupConfig, steamId: string) {
		if (!/^[0-9]{17}$/.test(steamId))
			return '用法：/绑定 你的SteamID64\nSteamID64 是 17 位数字。请先进入本群对应的游戏服务器。';
		if (this.store.binding(group.communityId, message.userId))
			return '你已经绑定了 Steam 账号。更换绑定请联系管理员。';
		const snapshot = await this.freshSnapshot(message, group);
		this.assertCurrentConfiguration(message);
		const player = snapshot.players.find((item) => item.steamId === steamId);
		if (!player)
			return '没有在服务器中找到这个 Steam 账号。请先进入本群对应的服务器，再发送绑定命令。';
		const code = this.code();
		this.assertCurrentConfiguration(message);
		this.store.beginBinding(group.communityId, message.userId, steamId, code, this.now());
		try {
			await this.warcon.whisper(
				group.serverId,
				steamId,
				`QQ账号 ${message.userId} 正在申请绑定此 Steam 账号。只有你本人发起时，才在 QQ 群发送 /验证 ${code}。5分钟内有效，请勿转告他人。`
			);
		} catch {
			this.assertCurrentConfiguration(message);
			return '游戏内验证码发送结果暂不确定。如果已收到，请在5分钟内发送 /验证 验证码；否则请一分钟后重新申请。验证码不会在QQ群展示。';
		}
		this.assertCurrentConfiguration(message);
		return `已向游戏中的 ${cleanName(player.name)} 发送绑定验证码，请在5分钟内发送 /验证 6位验证码。验证码只在游戏内展示。`;
	}
	private verify(message: BotMessage, group: GroupConfig, code: string) {
		if (!/^[0-9]{6}$/.test(code))
			return '用法：/验证 6位验证码。请使用刚刚在游戏内私信中收到的验证码。';
		this.assertCurrentConfiguration(message);
		const binding = this.store.verifyBinding(group.communityId, message.userId, code, this.now());
		return `绑定成功：${binding.steamId}\n现在可以 /签到、/积分、/查对局 或 /换边 蓝。`;
	}
	private checkin(message: BotMessage, group: GroupConfig) {
		this.requireBinding(message, group);
		const day = dayInZone(this.now(), group.timezone);
		this.assertCurrentConfiguration(message);
		const result = this.store.checkin(
			group.communityId,
			message.userId,
			day,
			group.checkinPoints,
			this.now()
		);
		return result.added
			? `签到成功！+${group.checkinPoints} 积分，当前余额 ${result.balance}。\n签到日期：${day}（${group.timezone}）`
			: `今天已经签到过啦，当前余额 ${result.balance} 积分。\n次日零点可再次签到（${group.timezone}）。`;
	}
	private async points(message: BotMessage, group: GroupConfig) {
		const binding = this.requireBinding(message, group);
		const lines = [`积分余额：${this.store.balance(group.communityId, message.userId)}`];
		const pending = this.store.pending(group.communityId, binding.steamId);
		if (pending)
			lines.push(
				`换边暂扣：${pending.cost} 积分；${pending.state === 'unknown' ? '结果待管理员核实' : '处理中'}。订单：${pending.id}`
			);
		try {
			const reserved = await this.warcon.reserved(group.serverId, binding.steamId);
			this.assertCurrentConfiguration(message);
			if (reserved.state === 'active')
				lines.push(
					`免排队：名单已配置；${reserved.expiresAt ? `到期 ${formatTime(reserved.expiresAt, group.timezone)}` : '未设置到期时间'}。`
				);
			else if (reserved.state === 'none') lines.push('免排队：当前没有有效名额。');
			else if (reserved.state === 'pending') lines.push('免排队：名单同步中，尚未确认生效。');
			else lines.push('免排队：状态暂不可用，请联系管理员确认。');
		} catch (error) {
			if (error instanceof BotUserError) throw error;
			this.assertCurrentConfiguration(message);
			lines.push('免排队：暂时查询失败，积分余额不受影响。');
		}
		return lines.join('\n');
	}
	private renderSnapshot(snapshot: GameSnapshot, group: GroupConfig) {
		return [
			`${group.serverName} · ${cleanName(snapshot.map)}`,
			`在线 ${snapshot.playerCount}/${snapshot.maxPlayers}`,
			...snapshot.scores.map((score) => `${cleanName(score.name)}：${score.score} 分`)
		].join('\n');
	}
	private async match(message: BotMessage, group: GroupConfig) {
		const snapshot = await this.freshSnapshot(message, group);
		this.assertCurrentConfiguration(message);
		const binding = this.store.binding(group.communityId, message.userId);
		const player = binding && snapshot.players.find((item) => item.steamId === binding.steamId);
		return [
			this.renderSnapshot(snapshot, group),
			'',
			player
				? `${cleanName(player.name)} · ${cleanName(player.faction ?? '尚未加入阵营')}\n击杀 ${player.kills} / 死亡 ${player.deaths} / 延迟 ${player.ping ?? '未知'} ms`
				: binding
					? '你目前不在这个服务器中。'
					: BIND_HELP
		].join('\n');
	}
	private validateMove(snapshot: GameSnapshot, binding: Binding, faction: string) {
		if (!snapshot.canMove)
			throw new BotUserError('当前服务器未开放机器人换边，或机器人账号没有换边权限。');
		if (!snapshot.scores.some((score) => score.name === faction))
			throw new BotUserError('本群的阵营映射与当前对局不匹配，请管理员检查配置后重试。');
		const player = snapshot.players.find((item) => item.steamId === binding.steamId);
		if (!player) throw new BotUserError('你目前不在本群对应的游戏服务器中。请进入服务器后再试。');
		if (player.faction === faction)
			throw new BotUserError(`你已经在 ${cleanName(faction)} 阵营，无需换边，也不会扣积分。`);
	}
	private async quoteMove(message: BotMessage, group: GroupConfig, color: string) {
		if (!['蓝', '红', '绿'].includes(color))
			return '用法：/换边 蓝（或红、绿）。也支持 /换边蓝、/换边红、/换边绿。';
		const binding = this.requireBinding(message, group);
		const faction = group.factions[color as TeamColor];
		const snapshot = await this.freshSnapshot(message, group);
		this.assertCurrentConfiguration(message);
		this.validateMove(snapshot, binding, faction);
		this.store.assertCanMove(
			group.communityId,
			binding.steamId,
			group.moveCooldownSeconds,
			this.now()
		);
		const balance = this.store.balance(group.communityId, message.userId);
		if (balance < group.moveCost)
			return `积分不足：换边需要 ${group.moveCost}，当前余额 ${balance}。可以通过 /签到 获取积分。`;
		const code = this.code();
		this.assertCurrentConfiguration(message);
		this.store.prepareMove(binding, group.serverId, faction, group.moveCost, code, this.now());
		return `准备换到${color}方 ${cleanName(faction)}，费用 ${group.moveCost} 积分（当前 ${balance}）。\n角色会重新部署，可能丢失当前装备；换边后冷却 ${group.moveCooldownSeconds} 秒。\n如确认，请在2分钟内发送 /确认 ${code}；不回复即取消。`;
	}
	private operationReply(operation: MoveOperation) {
		switch (operation.state) {
			case 'succeeded':
				return `换边指令已成功执行：${cleanName(operation.faction)}，扣除 ${operation.cost} 积分。当前余额 ${this.store.balance(operation.communityId, operation.userId)}。`;
			case 'refunded':
				return `换边未执行，${operation.cost} 积分已退回。可重新发送换边命令。`;
			case 'running':
				return '换边正在处理，请稍候。重复确认不会再次扣分或执行。';
			case 'unknown':
				return `换边结果暂不确定，${operation.cost} 积分已暂扣。请联系管理员核实订单 ${operation.id}。系统不会自动重复换边或退款。`;
		}
	}
	private async confirmMove(message: BotMessage, group: GroupConfig, code: string) {
		if (!/^[0-9]{6}$/.test(code))
			return '用法：/确认 6位确认码。请使用机器人给你的最新换边确认码。';
		const binding = this.requireBinding(message, group);
		const confirmation = this.store.confirmation(
			group.communityId,
			message.userId,
			group.serverId,
			code,
			this.now()
		);
		if (confirmation.operationId)
			return this.operationReply(this.store.operation(confirmation.operationId)!);
		if (
			confirmation.cost !== group.moveCost ||
			!Object.values(group.factions).includes(confirmation.faction)
		)
			return '换边费用或阵营配置已更新，请重新发送换边命令。';
		const snapshot = await this.freshSnapshot(message, group);
		this.assertCurrentConfiguration(message);
		this.validateMove(snapshot, binding, confirmation.faction);
		this.assertCurrentConfiguration(message);
		// Claim and dispatch run without an await between them, using this checked configuration.
		const { operation, claimed } = this.store.claimMove(
			confirmation.id,
			group.moveCooldownSeconds,
			this.now()
		);
		if (!claimed) return this.operationReply(operation);
		try {
			await this.warcon.move(group.serverId, binding.steamId, operation.faction);
		} catch (error) {
			if (error instanceof WarconError && error.effect === 'refused') {
				return this.operationReply(
					this.store.resolveOperation(
						operation.id,
						'refunded',
						'服务器明确拒绝换边，未执行',
						this.now()
					)
				);
			}
			this.store.markUnknown(operation.id, '服务器或网络未确认结果，需要管理员核实');
			return this.operationReply(this.store.operation(operation.id)!);
		}
		// After dispatch, settle the original operation even if configuration changed while awaiting the remote result.
		// If recording success fails, the running row remains for reconciliation. Never refund a successful action.
		return this.operationReply(
			this.store.resolveOperation(operation.id, 'succeeded', '服务器确认执行成功', this.now())
		);
	}
}
