import { createHmac, timingSafeEqual } from 'node:crypto';
import { qqId, type BotConfig } from './config';
import type { BotHandler, BotMessage } from './contracts';
import { Inbox } from './inbox';
import type { NapCatConnection } from './napcat-connection';
import { groupReply, renderReply, type ReplyOverrides } from './reply-copy';

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function validSignature(
	body: Uint8Array,
	signature: string | null,
	secret: string
): boolean {
	if (!signature || !/^sha1=[a-f0-9]{40}$/.test(signature)) return false;
	return timingSafeEqual(
		createHmac('sha1', secret).update(body).digest(),
		Buffer.from(signature.slice(5), 'hex')
	);
}

export function parseMessage(event: unknown, selfId: string, now: number): BotMessage | null {
	if (!event || typeof event !== 'object') return null;
	const e = event as Record<string, unknown>;
	if (
		e.post_type !== 'message' ||
		e.message_type !== 'group' ||
		e.sub_type !== 'normal' ||
		qqId(e.self_id) !== selfId ||
		e.anonymous
	)
		return null;
	const userId = qqId(e.user_id),
		groupId = qqId(e.group_id);
	if (
		!userId ||
		!groupId ||
		userId === selfId ||
		typeof e.time !== 'number' ||
		Math.abs(now - e.time * 1000) > 120000
	)
		return null;
	const id =
		typeof e.message_id === 'number' && Number.isSafeInteger(e.message_id)
			? String(e.message_id)
			: e.message_id;
	if (typeof id !== 'string' || !/^-?\d{1,20}$/.test(id)) return null;
	// Use only current message text; quoted-message metadata never supplies command content.
	if (!Array.isArray(e.message) || e.message.length > 30) return null;
	let text = '',
		mentioned = false;
	for (const segment of e.message) {
		if (!segment || !segment.data) return null;
		if (segment.type === 'text' && typeof segment.data.text === 'string') text += segment.data.text;
		else if (segment.type === 'at' && String(segment.data.qq) === selfId) mentioned = true;
		else if (segment.type === 'reply') continue;
		else return null;
	}
	text = text.trim().replace(/^／/, '/');
	if (!text || text.length > 300 || (!text.startsWith('/') && !mentioned)) return null;
	if (!text.startsWith('/')) text = '/' + text;
	return { id, groupId, userId, text, time: e.time * 1000 };
}

async function smallBody(request: Request): Promise<Uint8Array> {
	if (Number(request.headers.get('content-length')) > 65536) throw new Error('too large');
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			length += part.value.length;
			if (length > 65536) {
				await reader.cancel();
				throw new Error('too large');
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, length);
}

export class NapCatBot {
	private working: Promise<void> | null = null;
	constructor(
		private config: BotConfig,
		private inbox: Inbox,
		private handler: BotHandler,
		private fetcher: Fetcher = fetch,
		private now: () => number = Date.now,
		private connection?: NapCatConnection,
		private active: () => boolean = () => true,
		private replyTemplates: () => ReplyOverrides = () => ({})
	) {}
	async receive(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true });
		if (request.method !== 'POST' || url.pathname !== '/onebot/events')
			return new Response('Not found', { status: 404 });
		// Backup callbacks are acknowledged but never queued while the official channel is active.
		if (!this.active()) return Response.json({});
		let body: Uint8Array;
		try {
			body = await smallBody(request);
		} catch {
			return new Response('Too large', { status: 413 });
		}
		if (!validSignature(body, request.headers.get('x-signature'), this.config.webhookSecret))
			return new Response('Unauthorized', { status: 401 });
		// Signed callbacks can prompt discovery, but cannot choose the active account themselves.
		await this.connection?.refresh(request.headers.get('x-self-id') !== this.config.selfId);
		if (!this.active()) return Response.json({});
		if (this.connection && !this.connection.status().online)
			return new Response('QQ offline', { status: 503 });
		if (request.headers.get('x-self-id') !== this.config.selfId)
			return new Response('Unauthorized', { status: 401 });
		let event: unknown;
		try {
			event = JSON.parse(new TextDecoder().decode(body));
		} catch {
			return new Response('Invalid JSON', { status: 400 });
		}
		if (
			event &&
			typeof event === 'object' &&
			qqId((event as Record<string, unknown>).self_id) === this.config.selfId
		)
			this.connection?.recordEvent();
		const message = parseMessage(event, this.config.selfId, this.now());
		if (!message || !this.config.groups.some((g) => g.groupId === message.groupId))
			return Response.json({});
		message.configurationRevision = this.config.revision;
		const result = this.inbox.accept(
			`${this.config.selfId}:${message.groupId}:${message.id}`,
			message,
			this.now()
		);
		if (result === 'limited') return new Response('Rate limited', { status: 429 });
		return Response.json({}); // Persist first; the worker sends replies through NapCat's HTTP API.
	}
	pump(): Promise<void> {
		if (!this.working)
			this.working = this.drain().finally(() => {
				this.working = null;
			});
		return this.working;
	}
	private async drain(): Promise<void> {
		if (!this.active()) return;
		await this.connection?.refresh();
		if (!this.active()) return;
		if (this.connection && !this.connection.status().online) return;
		// Limit each pass so shutdown/maintenance gets a chance under sustained input.
		for (let i = 0; i < 20; i++) {
			if (!this.active()) return;
			if (!this.inbox.hasWork('pending')) break;
			await this.connection?.refresh(true);
			if (!this.active()) return;
			if (this.connection && !this.connection.status().online) return;
			const row = this.inbox.claim();
			if (!row) break;
			let reply = renderReply('transport.incomplete', {}, this.replyTemplates());
			try {
				const message: BotMessage = JSON.parse(row.payload);
				const group = this.config.groups.find((g) => g.groupId === message.groupId);
				if (!group || message.officialReply)
					reply = renderReply('transport.disabled', {}, this.replyTemplates());
				else if (message.configurationRevision !== this.config.revision)
					reply = renderReply('transport.changed', {}, this.replyTemplates());
				else if (this.now() - message.time > 120000)
					reply = renderReply('transport.expired', {}, this.replyTemplates());
				else reply = await this.handler.handle(message, group);
			} catch {
				/* Never log message bodies, verification codes or upstream credentials. */
			}
			this.inbox.finish(row.key, reply);
			await this.sendReplies();
		}
		await this.sendReplies();
	}
	private async sendReplies(): Promise<void> {
		for (let i = 0; i < 20; i++) {
			if (!this.active()) return;
			if (!this.inbox.hasWork('done')) return;
			// Refresh after awaiting a command: an account may have changed while the game API was busy.
			await this.connection?.refresh(true);
			if (!this.active()) return;
			if (this.connection && !this.connection.status().online) return;
			const row = this.inbox.claimReply();
			if (!row) break;
			let success = false;
			try {
				if (row.reply_target) throw new Error('Official reply cannot use NapCat');
				const response = await this.fetcher(`${this.config.napcatUrl}/send_group_msg`, {
					method: 'POST',
					redirect: 'error',
					signal: AbortSignal.timeout(10000),
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${this.config.napcatToken}`
					},
					body: JSON.stringify({
						group_id: Number(row.group_id),
						message: [
							{ type: 'at', data: { qq: row.user_id } },
							{
								type: 'text',
								data: { text: '\n' + groupReply(row.reply ?? '', this.replyTemplates()) }
							}
						]
					})
				});
				const data = response.ok ? await response.json() : null;
				success =
					data?.status === 'ok' && data?.retcode === 0 && data?.data?.message_id !== undefined;
			} catch {
				/* Delivery may have succeeded: never retry ambiguous replies automatically. */
			}
			this.inbox.replied(row.key, success);
		}
	}
}
