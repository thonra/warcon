import { QQBot, type QQBotInboundMessage, type QQBotOptions } from '@tencent-connect/qqbot-nodejs';
import { officialId, type BotConfig } from './config';
import type { BotHandler, BotMessage, GroupConfig } from './contracts';
import type { MessagingSettings } from './admin-contracts';
import type { NapCatStatus } from './napcat-connection';
import { Inbox } from './inbox';
import { groupReply, renderReply, type ReplyOverrides, type ReplyKey } from './reply-copy';
import { managementInput } from './management-catalog';

const GROUP_EVENTS = new Set([
	'GROUP_ADD_ROBOT',
	'GROUP_DEL_ROBOT',
	'GROUP_MSG_RECEIVE',
	'GROUP_MSG_REJECT'
]);
export interface OfficialStatus extends NapCatStatus {
	provider: 'official';
	appId: string;
	phase: 'unconfigured' | 'connecting' | 'online' | 'offline' | 'standby';
	groups: { openid: string; lastSeenAt: number }[];
	privateUsers: { openid: string; lastSeenAt: number }[];
	/** Recent lifecycle notifications observed by this process, not a complete membership list. */
	groupEvents: { event: string; openid: string; receivedAt: number }[];
	lastReplyError: string | null;
	buttonsAvailable: boolean;
	receivedMessages: number;
	filteredMessages: number;
	unmappedMessages: number;
	lastReceivedAt: number | null;
	sdkErrors: number;
	lastSdkError: string | null;
}
export type OfficialClient = Pick<QQBot, 'on' | 'start' | 'stop' | 'apiClient' | 'tokenManager'>;
export type OfficialFactory = (options: QQBotOptions) => OfficialClient;

/** Accept mentioned commands or explicit slash commands in full-message mode; never quoted/media content. */
export function officialMessage(
	raw: QQBotInboundMessage,
	appId: string,
	now: number
): BotMessage | null {
	const privateChat = raw.kind === 'c2c' && raw.rawEventType === 'C2C_MESSAGE_CREATE';
	if (
		(!privateChat &&
			(raw.kind !== 'group' ||
				!['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(raw.rawEventType))) ||
		raw.senderIsBot ||
		(raw.raw as { author?: { bot?: boolean } })?.author?.bot ||
		(!privateChat && !officialId(raw.groupOpenid)) ||
		(raw.msgType !== undefined && ![0, 103].includes(raw.msgType)) ||
		!officialId(raw.senderId) ||
		typeof raw.messageId !== 'string' ||
		!/^\S{1,512}$/.test(raw.messageId) ||
		(raw.msgIdx !== undefined &&
			(typeof raw.msgIdx !== 'string' || !/^\S{1,512}$/.test(raw.msgIdx))) ||
		typeof raw.content !== 'string' ||
		raw.attachments?.length
	)
		return null;
	const time = Date.parse(raw.timestamp);
	if (!Number.isFinite(time) || Math.abs(now - time) > 120_000) return null;
	let text = raw.content
		.replace(/^\s*<@!?[a-zA-Z0-9_-]+>\s*/, '')
		.trim()
		.replace(/^／/, '/');
	// QQ strips the @bot prefix. A plain bare mention opens help; quoted/media messages stay ignored.
	if (
		!text &&
		raw.rawEventType === 'GROUP_AT_MESSAGE_CREATE' &&
		(raw.msgType === undefined || raw.msgType === 0) &&
		!raw.msgElements?.length
	)
		text = '/帮助';
	if (
		!text ||
		text.length > 2048 ||
		(text.length > 300 && !managementInput(text)) ||
		/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)
	)
		return null;
	if (raw.rawEventType === 'GROUP_MESSAGE_CREATE' && !text.startsWith('/')) return null;
	if (!text.startsWith('/')) text = '/' + text;
	return {
		id: raw.messageId,
		groupId: privateChat ? raw.senderId : raw.groupOpenid!,
		userId: privateChat
			? `qqofficial:c2c:${appId}:${raw.senderId}`
			: `qqofficial:${appId}:${raw.groupOpenid}:${raw.senderId}`,
		text,
		time
	};
}

function safeError(error: unknown, fallback: string): string {
	// SDK error strings can contain upstream response bodies; expose only bounded numeric codes.
	const e = error as { bizCode?: unknown; httpStatus?: unknown } | null;
	const code =
		typeof e?.bizCode === 'number' && Number.isSafeInteger(e.bizCode)
			? e.bizCode
			: typeof e?.httpStatus === 'number' && Number.isSafeInteger(e.httpStatus)
				? e.httpStatus
				: null;
	return fallback + (code ? `（代码 ${code}）` : '');
}

/** Type 2 inserts @bot + command in QQ's input. Confirmation still requires sending the command. */
export function commandKeyboard(reply: string, memberOpenid: string) {
	const confirmation = reply.match(/发送 \/确认 ([0-9]{6})/);
	const rows = confirmation
		? [
				[
					['确认换边', `/确认 ${confirmation[1]}`],
					['取消', '/取消']
				]
			]
		: [
				[
					['签到', '/签到'],
					['积分', '/积分'],
					['查对局', '/查对局']
				],
				[
					['换边蓝', '/换边 蓝'],
					['换边红', '/换边 红'],
					['换边绿', '/换边 绿']
				],
				[
					['使用帮助', '/帮助'],
					['取消请求', '/取消']
				]
			];
	return {
		content: {
			rows: rows.map((row, r) => ({
				buttons: row.map(([label, data], c) => ({
					id: `command_${r}_${c}`,
					render_data: { label, style: 0 },
					action: {
						type: 2,
						permission: { type: 0, specify_user_ids: [memberOpenid] },
						data,
						enter: false
					}
				}))
			}))
		}
	};
}
const KEYBOARD_REFUSALS = new Set([
	22006, 304036, 304037, 304038, 304039, 304040, 305007, 40034029, 40034127
]);

/** Owns one outbound official connection. Changing provider/credentials retires its entire generation. */
export class OfficialBot {
	private client: OfficialClient | null = null;
	private generation = 0;
	private working: Promise<void> | null = null;
	private running: Promise<void> | null = null;
	private settings: MessagingSettings = { provider: 'napcat', appId: '', appSecret: '' };
	private retryAt = 0;
	private stopped = false;
	private seen = new Map<string, number>();
	private seenPrivate = new Map<string, number>();
	private state: Omit<OfficialStatus, 'groups' | 'privateUsers'> = {
		provider: 'official',
		appId: '',
		selfId: '',
		nickname: '',
		phase: 'standby',
		online: false,
		checkedAt: null,
		lastEventAt: null,
		error: null,
		lastReplyError: null,
		buttonsAvailable: true,
		groupEvents: [],
		receivedMessages: 0,
		filteredMessages: 0,
		unmappedMessages: 0,
		lastReceivedAt: null,
		sdkErrors: 0,
		lastSdkError: null
	};
	constructor(
		private config: BotConfig,
		private inbox: Inbox,
		private handler: BotHandler,
		private factory: OfficialFactory = (options) => new QQBot(options),
		private now = Date.now,
		private replyTemplates: () => ReplyOverrides = () => ({})
	) {}
	private text(key: ReplyKey) {
		return renderReply(key, {}, this.replyTemplates());
	}

	status(): OfficialStatus {
		return {
			...this.state,
			groups: [...this.seen].map(([openid, lastSeenAt]) => ({ openid, lastSeenAt })),
			privateUsers: [...this.seenPrivate].map(([openid, lastSeenAt]) => ({ openid, lastSeenAt }))
		};
	}
	configure(settings: MessagingSettings): void {
		if (JSON.stringify(settings) === JSON.stringify(this.settings)) return;
		const changedApp = settings.appId !== this.settings.appId;
		this.settings = { ...settings };
		this.retire();
		this.stopped = false;
		if (changedApp) {
			this.seen.clear();
			this.seenPrivate.clear();
			this.state.groupEvents = [];
		}
		this.state = {
			...this.state,
			...(changedApp
				? {
						receivedMessages: 0,
						filteredMessages: 0,
						unmappedMessages: 0,
						lastReceivedAt: null,
						sdkErrors: 0,
						lastSdkError: null
					}
				: {}),
			appId: settings.appId,
			selfId: '',
			nickname: '',
			online: false,
			buttonsAvailable: settings.buttons !== false,
			lastEventAt: null,
			lastReplyError: null,
			error: null,
			checkedAt: this.now(),
			phase: settings.provider === 'official' ? 'unconfigured' : 'standby'
		};
		this.retryAt = 0;
		this.tick();
	}
	private retire(): void {
		this.generation++;
		this.client?.stop();
		this.client = null;
		this.running = null;
	}
	stop(): void {
		this.stopped = true;
		this.retire();
		this.state.online = false;
	}
	reconnect(): void {
		this.retire();
		this.state.online = false;
		this.stopped = false;
		this.retryAt = 0;
		this.tick();
	}
	tick(): void {
		if (
			this.stopped ||
			this.settings.provider !== 'official' ||
			this.running ||
			this.now() < this.retryAt
		)
			return;
		const { appId, appSecret } = this.settings;
		if (!appId || !appSecret) {
			this.state.phase = 'unconfigured';
			this.state.error = '请配置 AppID 和 AppSecret。';
			return;
		}
		const generation = ++this.generation;
		const active = () =>
			generation === this.generation && !this.stopped && this.settings.provider === 'official';
		this.state.phase = 'connecting';
		this.state.checkedAt = this.now();
		this.state.error = null;
		const client = this.factory({
			appId,
			appSecret,
			transport: 'websocket',
			intents: 1 << 25,
			baseUrl: 'https://api.bot.qq.com',
			tokenBaseUrl: 'https://api.bot.qq.com',
			markdownSupport: false,
			logger: {
				info: () => {},
				error: (message) => {
					if (!active()) return;
					const parse = message.includes('Message parse error');
					this.state.sdkErrors++;
					this.state.lastSdkError = parse
						? '官方消息解析失败，请检查接收记录。'
						: '官方 SDK 发生错误，请检查连接与接收记录。';
					// SDK strings may contain response bodies. Persist only a fixed category.
					console.warn(
						JSON.stringify({ type: 'qq.sdk_error', appId, category: parse ? 'parse' : 'sdk' })
					);
				}
			},
			reconnect: { maxAttempts: 10 }
		});
		this.client = client;
		const ready = (raw: unknown) => {
			if (!active()) return;
			const user = (raw as { user?: { id?: string; username?: string } })?.user;
			this.state = {
				...this.state,
				online: true,
				phase: 'online',
				error: null,
				checkedAt: this.now(),
				selfId: typeof user?.id === 'string' ? user.id.slice(0, 128) : this.state.selfId,
				nickname:
					typeof user?.username === 'string' ? user.username.slice(0, 100) : this.state.nickname
			};
		};
		client.on('ready', ready);
		client.on('resumed', ready);
		client.on('disconnected', () => {
			if (!active()) return;
			this.state.online = false;
			this.state.phase = 'connecting';
			this.state.checkedAt = this.now();
			this.state.error = '官方连接已断开，正在自动重连。';
		});
		client.on('error', (error) => {
			if (active())
				this.state.error = safeError(error, '官方接口暂时不可用，请检查凭据、机器人权限及网络。');
		});
		client.on('rawEvent', ({ eventType, data }) => {
			if (!active() || !this.state.online || !GROUP_EVENTS.has(eventType)) return;
			const openid = (data as { group_openid?: unknown } | null)?.group_openid;
			if (!officialId(openid)) return;
			const receivedAt = this.now();
			const event = { event: eventType, openid, receivedAt };
			this.state.lastEventAt = receivedAt;
			this.state.groupEvents = [event, ...this.state.groupEvents].slice(0, 30);
			this.seen.delete(openid);
			if (eventType !== 'GROUP_DEL_ROBOT') this.seen.set(openid, receivedAt);
			if (this.seen.size > 100) this.seen.delete(this.seen.keys().next().value!);
			// Record only identifiers and event type. Never log raw data, messages, or operator identity.
			console.info(JSON.stringify({ type: 'qq.group_event', appId, ...event }));
		});
		client.on('message', (_ctx, raw) => {
			if (!active() || !this.state.online) return;
			this.state.receivedMessages++;
			this.state.lastReceivedAt = this.now();
			const message = officialMessage(raw, appId, this.now());
			if (!message) {
				this.state.filteredMessages++;
				return;
			}
			this.state.lastEventAt = this.now();
			const privateChat = raw.kind === 'c2c';
			const seen = privateChat ? this.seenPrivate : this.seen;
			seen.delete(message.groupId);
			seen.set(message.groupId, this.now());
			if (seen.size > 100) seen.delete(seen.keys().next().value!);
			const tester = privateChat
				? this.settings.privateTests?.find(
						(t) => t.appId === appId && t.userOpenid === raw.senderId
					)
				: undefined;
			const group = this.config.groups.find((g) =>
				privateChat
					? g.groupId === tester?.groupId
					: g.officialAppId === appId && g.officialGroupId === message.groupId
			);
			if (!group) {
				this.state.unmappedMessages++;
				return; // Discovery never grants command access, in either conversation type.
			}
			message.officialReply = {
				appId,
				...(managementInput(message.text) ? { management: true } : {}),
				...(privateChat
					? { scope: 'c2c' as const, userOpenid: raw.senderId }
					: { groupOpenid: message.groupId }),
				messageId: message.id,
				revision: this.config.revision!
			};
			message.groupId = group.groupId;
			message.configurationRevision = this.config.revision;
			this.inbox.accept(
				privateChat
					? `official:c2c:${appId}:${raw.senderId}:${raw.msgIdx ? 'idx:' + raw.msgIdx : 'id:' + message.id}`
					: `official:${appId}:${raw.groupOpenid}:${message.id}`,
				message,
				this.now()
			);
		});
		this.running = client
			.start()
			.catch((error) => {
				if (active())
					this.state.error = safeError(
						error,
						'官方连接失败，请核对 AppID、AppSecret、机器人权限及网络；30 秒后重试。'
					);
			})
			.finally(() => {
				client.stop();
				if (!active()) return;
				this.running = null;
				this.state.online = false;
				this.state.phase = 'offline';
				this.state.checkedAt = this.now();
				this.retryAt = this.now() + 30_000;
			});
	}
	pump(): Promise<void> {
		this.tick();
		if (!this.working)
			this.working = this.drain().finally(() => {
				this.working = null;
			});
		return this.working;
	}
	private active(generation: number): boolean {
		return (
			generation === this.generation &&
			this.settings.provider === 'official' &&
			this.state.online &&
			!this.stopped
		);
	}
	private authorized(target: BotMessage['officialReply'], group: GroupConfig | undefined): boolean {
		if (!target || !group || target.appId !== this.settings.appId) return false;
		return target.scope === 'c2c'
			? !!this.settings.privateTests?.some(
					(t) =>
						t.appId === target.appId &&
						t.userOpenid === target.userOpenid &&
						t.groupId === group.groupId
				)
			: group.officialAppId === target.appId && group.officialGroupId === target.groupOpenid;
	}
	private async drain(): Promise<void> {
		const generation = this.generation;
		for (let i = 0; i < 20 && this.active(generation); i++) {
			const row = this.inbox.claim();
			if (!row) break;
			let reply = this.text('transport.incomplete');
			try {
				const message: BotMessage = JSON.parse(row.payload);
				const group = this.config.groups.find((g) => g.groupId === message.groupId);
				if (!this.authorized(message.officialReply, group)) reply = this.text('transport.disabled');
				else if (message.configurationRevision !== this.config.revision)
					reply = this.text('transport.changed');
				else if (this.now() - message.time > 120_000) reply = this.text('transport.expired');
				else reply = await this.handler.handle(message, group!);
			} catch {
				/* Never expose message text, codes or upstream credentials. */
			}
			this.inbox.finish(row.key, reply);
			await this.sendReplies(generation);
		}
		await this.sendReplies(generation);
	}
	private async sendReplies(generation: number): Promise<void> {
		for (let i = 0; i < 20 && this.active(generation); i++) {
			const row = this.inbox.claimReply();
			if (!row) return;
			let success = false;
			try {
				const target = row.reply_target
					? (JSON.parse(row.reply_target) as BotMessage['officialReply'])
					: null;
				const group = this.config.groups.find((g) => g.groupId === row.group_id);
				if (
					target &&
					target.appId === this.settings.appId &&
					target.revision === this.config.revision &&
					this.authorized(target, group) &&
					this.now() - row.accepted_at <= 120_000
				) {
					const client = this.client!;
					const token = await client.tokenManager.getAccessToken(
						this.settings.appId,
						this.settings.appSecret
					);
					// Config/provider can change while token retrieval is in flight.
					if (!this.active(generation) || target.revision !== this.config.revision)
						throw new Error();
					const content =
						target.scope === 'c2c'
							? renderReply(
									'private.wrapper',
									{ serverName: group!.serverName, reply: row.reply ?? '' },
									this.replyTemplates()
								)
							: groupReply(row.reply ?? '', this.replyTemplates());
					const send = async (keyboard: boolean) => {
						const response = await client.apiClient.request<{
							id?: unknown;
							code?: number;
							err_code?: number;
						}>(
							token,
							'POST',
							target.scope === 'c2c'
								? `/v2/users/${encodeURIComponent(target.userOpenid)}/messages`
								: `/v2/groups/${encodeURIComponent(target.groupOpenid)}/messages`,
							{
								msg_type: 0,
								content,
								msg_id: target.messageId,
								msg_seq: 1,
								...(keyboard
									? { keyboard: commandKeyboard(row.reply ?? '', row.user_id.split(':').at(-1)!) }
									: {})
							},
							{ timeoutMs: 10_000 }
						);
						if (response?.err_code || response?.code)
							throw { bizCode: response.err_code || response.code };
						return response;
					};
					let response;
					try {
						response = await send(this.state.buttonsAvailable && !target.management);
					} catch (error) {
						const code = (error as { bizCode?: number })?.bizCode;
						// Only a definite keyboard refusal permits a text fallback; never repeat the command.
						if (
							target.management ||
							!this.state.buttonsAvailable ||
							!code ||
							!KEYBOARD_REFUSALS.has(code) ||
							!this.active(generation) ||
							target.revision !== this.config.revision
						)
							throw error;
						this.state.buttonsAvailable = false;
						response = await send(false);
					}
					success = typeof response?.id === 'string' && Boolean(response.id);
					if (this.active(generation))
						this.state.lastReplyError = success
							? null
							: '官方接口未确认回复送达，请核对消息权限及操作记录。';
				}
			} catch (error) {
				if (this.active(generation))
					this.state.lastReplyError = safeError(
						error,
						'回复未确认送达，请检查官方消息权限及操作记录；系统不会重复执行命令。'
					);
			}
			this.inbox.replied(row.key, success); // Ambiguous delivery is never automatically retried.
		}
	}
}
