import { renderReply, type ReplyKey, type ReplyOverrides, type ReplyValues } from './reply-copy';
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
	private readonly replyTemplates: () => ReplyOverrides;
	constructor(
		private readonly store: BotStore,
		private readonly warcon: WarconPort,
		options: {
			now?: () => number;
			code?: () => string;
			configurationRevision?: () => string | undefined;
			replyTemplates?: () => ReplyOverrides;
		} = {}
	) {
		this.now = options.now ?? Date.now;
		this.replyTemplates = options.replyTemplates ?? (() => ({}));
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
				aliases: ['取消'],
				usage: '取消',
				description: '取消待验证绑定和未确认的换边',
				run: (message, group) =>
					this.store.cancelPending(group.communityId, message.userId, group.serverId)
						? this.text('cancel.success')
						: this.text('cancel.none')
			},
			{
				aliases: ['确认'],
				usage: '确认 6位确认码',
				description: '确认自己的待处理换边',
				run: (message, group, argument) => this.confirmMove(message, group, argument)
			}
		];
	}
	private text(key: ReplyKey, values: ReplyValues = {}) {
		return renderReply(key, values, this.replyTemplates());
	}
	async handle(message: BotMessage, group: GroupConfig): Promise<string> {
		if (message.groupId !== group.groupId || !message.userId || !message.id)
			return this.text('command.unauthorized');
		message = { ...message, userId: this.store.accountUserId(group.communityId, message.userId) };
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
			if (!definition) return this.text('command.unknown');
			return await definition.run(message, group, argument);
		} catch (error) {
			if (error instanceof BotUserError) return error.message;
			// Never echo transport errors: they can contain URLs, credentials or raw responses.
			return this.text('command.failed');
		}
	}
	private assertCurrentConfiguration(message: BotMessage) {
		if (
			this.configurationRevision &&
			message.configurationRevision !== this.configurationRevision()
		)
			throw new BotUserError(this.text('command.changed'));
	}
	private help(group: GroupConfig) {
		return [
			this.text('help.title', { serverName: group.serverName }),
			this.text('help.commands', {
				commands: this.commands
					.map(({ usage, description }) => `/${usage} — ${description}`)
					.join('\n')
			}),
			'',
			this.text('help.economy', {
				points: group.checkinPoints,
				timezone: group.timezone,
				cost: group.moveCost,
				cooldown: group.moveCooldownSeconds
			}),
			this.text('help.footer')
		].join('\n');
	}
	private requireBinding(message: BotMessage, group: GroupConfig): Binding {
		const binding = this.store.binding(group.communityId, message.userId);
		if (!binding) throw new BotUserError(this.text('bind.required'));
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
			throw new BotUserError(this.text('server.stale'));
		return snapshot;
	}
	private async bind(message: BotMessage, group: GroupConfig, steamId: string) {
		if (!/^[0-9]{17}$/.test(steamId)) return this.text('bind.usage');
		if (this.store.binding(group.communityId, message.userId)) return this.text('bind.already');
		const snapshot = await this.freshSnapshot(message, group);
		this.assertCurrentConfiguration(message);
		const player = snapshot.players.find((item) => item.steamId === steamId);
		if (!player) return this.text('bind.offline');
		const code = this.code();
		this.assertCurrentConfiguration(message);
		this.store.beginBinding(group.communityId, message.userId, steamId, code, this.now());
		try {
			await this.warcon.whisper(
				group.serverId,
				steamId,
				`${message.officialReply ? '官方机器人用户' : 'QQ账号'} ${message.userId} 正在申请绑定此 Steam 账号并关联已有积分；只有你本人发起时，才在 QQ 群发送 /验证 ${code}；5分钟内有效，请勿转告他人`
			);
		} catch {
			this.assertCurrentConfiguration(message);
			return this.text('bind.uncertain');
		}
		this.assertCurrentConfiguration(message);
		return this.text('bind.sent', { playerName: cleanName(player.name) });
	}
	private verify(message: BotMessage, group: GroupConfig, code: string) {
		if (!/^[0-9]{6}$/.test(code)) return this.text('bind.verifyUsage');
		this.assertCurrentConfiguration(message);
		const binding = this.store.verifyBinding(group.communityId, message.userId, code, this.now());
		return this.text('bind.success', { steamId: binding.steamId });
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
			? this.text('checkin.success', {
					points: group.checkinPoints,
					balance: result.balance,
					day: day,
					timezone: group.timezone
				})
			: this.text('checkin.already', { balance: result.balance, timezone: group.timezone });
	}
	private async points(message: BotMessage, group: GroupConfig) {
		const binding = this.requireBinding(message, group);
		const lines = [
			this.text('points.summary', {
				steamId: binding.steamId,
				balance: this.store.balance(group.communityId, message.userId)
			})
		];
		const pending = this.store.pending(group.communityId, binding.steamId);
		if (pending)
			lines.push(
				this.text('points.pending', {
					cost: pending.cost,
					state: pending.state === 'unknown' ? '结果待管理员核实' : '处理中',
					orderId: pending.id
				})
			);
		try {
			const reserved = await this.warcon.reserved(group.serverId, binding.steamId);
			this.assertCurrentConfiguration(message);
			if (reserved.state === 'active')
				lines.push(
					this.text('reserved.active', {
						expiry: reserved.expiresAt
							? `到期 ${formatTime(reserved.expiresAt, group.timezone)}`
							: '未设置到期时间'
					})
				);
			else if (reserved.state === 'none') lines.push(this.text('reserved.none'));
			else if (reserved.state === 'pending') lines.push(this.text('reserved.pending'));
			else lines.push(this.text('reserved.unknown'));
		} catch (error) {
			if (error instanceof BotUserError) throw error;
			this.assertCurrentConfiguration(message);
			lines.push(this.text('reserved.failed'));
		}
		return lines.join('\n');
	}
	private renderSnapshot(snapshot: GameSnapshot, group: GroupConfig) {
		return this.text('server.summary', {
			serverName: group.serverName,
			map: cleanName(snapshot.map),
			playerCount: snapshot.playerCount,
			maxPlayers: snapshot.maxPlayers,
			scores: snapshot.scores
				.map((score) => `${cleanName(score.name)}：${score.score} 分`)
				.join('\n')
		}).trimEnd();
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
				? this.text('match.player', {
						playerName: cleanName(player.name),
						faction: cleanName(player.faction ?? '尚未加入阵营'),
						kills: player.kills,
						deaths: player.deaths,
						ping: player.ping ?? '未知'
					})
				: binding
					? this.text('match.offline')
					: this.text('bind.required')
		].join('\n');
	}
	private validateMove(snapshot: GameSnapshot, binding: Binding, faction: string) {
		if (!snapshot.canMove) throw new BotUserError(this.text('move.disabled'));
		if (!snapshot.scores.some((score) => score.name === faction))
			throw new BotUserError(this.text('move.mapping'));
		const player = snapshot.players.find((item) => item.steamId === binding.steamId);
		if (!player) throw new BotUserError(this.text('move.offline'));
		if (player.faction === faction)
			throw new BotUserError(this.text('move.same', { faction: cleanName(faction) }));
	}
	private async quoteMove(message: BotMessage, group: GroupConfig, color: string) {
		if (!['蓝', '红', '绿'].includes(color)) return this.text('move.usage');
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
			return this.text('move.insufficient', { cost: group.moveCost, balance: balance });
		const code = this.code();
		this.assertCurrentConfiguration(message);
		this.store.prepareMove(binding, group.serverId, faction, group.moveCost, code, this.now());
		return this.text('move.quote', {
			color: color,
			faction: cleanName(faction),
			cost: group.moveCost,
			balance: balance,
			cooldown: group.moveCooldownSeconds,
			code: code
		});
	}
	private operationReply(operation: MoveOperation) {
		switch (operation.state) {
			case 'succeeded':
				return this.text('move.success', {
					faction: cleanName(operation.faction),
					cost: operation.cost,
					balance: this.store.balance(operation.communityId, operation.userId)
				});
			case 'refunded':
				return this.text('move.refunded', { cost: operation.cost });
			case 'running':
				return this.text('move.running');
			case 'unknown':
				return this.text('move.unknown', { cost: operation.cost, orderId: operation.id });
		}
	}
	private async confirmMove(message: BotMessage, group: GroupConfig, code: string) {
		if (!/^[0-9]{6}$/.test(code)) return this.text('move.confirmUsage');
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
			return this.text('move.changed');
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
