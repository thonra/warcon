import { randomUUID } from 'node:crypto';
import { qqId, type BotConfig } from './config';
import type { Fetcher } from './napcat';

export interface NapCatStatus {
	selfId: string;
	nickname: string;
	online: boolean;
	checkedAt: number | null;
	lastEventAt: number | null;
	error: string | null;
}

/** Identity comes only from the configured, authenticated HTTP API, never a callback's self_id. */
export class NapCatConnection {
	private pending: Promise<void> | null = null;
	private nextCheck = 0;
	private state: NapCatStatus = {
		selfId: '',
		nickname: '',
		online: false,
		checkedAt: null,
		lastEventAt: null,
		error: '等待 NapCat 登录'
	};
	constructor(
		private config: BotConfig,
		private onSessionChanged: () => void,
		private fetcher: Fetcher = fetch,
		private now: () => number = Date.now
	) {
		// Even a configured previous QQ is not trusted until this process verifies the live session.
		config.selfId = '';
	}

	status(): NapCatStatus {
		return { ...this.state };
	}
	recordEvent(): void {
		this.state.lastEventAt = this.now();
	}

	refresh(force = false): Promise<void> {
		if (this.pending) return this.pending;
		if (!force && this.now() < this.nextCheck) return Promise.resolve();
		this.pending = this.check().finally(() => {
			this.nextCheck = this.now() + 5000;
			this.pending = null;
		});
		return this.pending;
	}

	private async read(action: string): Promise<Record<string, unknown>> {
		const response = await this.fetcher(`${this.config.napcatUrl}/${action}`, {
			method: 'POST',
			redirect: 'error',
			signal: AbortSignal.timeout(5000),
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${this.config.napcatToken}`
			},
			body: '{}'
		});
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			throw new Error('NapCat HTTP API 不可用，请检查服务与访问令牌。');
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				length += part.value.length;
				if (length > 65536) {
					await reader.cancel();
					throw new Error();
				}
				chunks.push(part.value);
			}
		} finally {
			reader.releaseLock();
		}
		const data = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
		if (
			data?.status !== 'ok' ||
			data.retcode !== 0 ||
			!data.data ||
			typeof data.data !== 'object' ||
			Array.isArray(data.data)
		)
			throw new Error();
		return data.data;
	}

	private async check(): Promise<void> {
		let next: NapCatStatus;
		try {
			const status = await this.read('get_status');
			if (status.online !== true || status.good !== true) {
				next = { ...this.state, online: false, error: 'QQ 未在线，请在 NapCat 中登录。' };
			} else {
				const info = await this.read('get_login_info');
				const selfId = qqId(info.user_id);
				if (!selfId) throw new Error();
				next = {
					selfId,
					nickname: typeof info.nickname === 'string' ? info.nickname.slice(0, 100) : '',
					online: true,
					checkedAt: null,
					lastEventAt:
						selfId === this.state.selfId && this.state.online ? this.state.lastEventAt : null,
					error: null
				};
			}
		} catch {
			// Do not expose API responses, network details, or tokens in the management page.
			next = {
				...this.state,
				online: false,
				error: '无法连接 NapCat，请检查服务与 HTTP API 配置。'
			};
		}
		next.checkedAt = this.now();
		const changed = next.online !== this.state.online || next.selfId !== this.state.selfId;
		this.state = next;
		this.config.selfId = next.online ? next.selfId : '';
		if (changed) {
			this.config.revision = randomUUID();
			this.onSessionChanged();
		}
	}
}
