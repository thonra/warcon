import { WarconError } from './contracts';
import type { GamePlayer, GameSnapshot, ReservedStatus, WarconPort } from './contracts';

type JsonObject = Record<string, unknown>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface WarconClientOptions {
	baseUrl: string;
	token: string;
	timeoutMs?: number;
	fetch?: Fetch;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const LIST_MAX_AGE_MS = 5 * 60_000;
const object = (value: unknown): value is JsonObject =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= max;
const count = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);
const malformed = () => new WarconError('Warcon 返回的数据不完整，请稍后查询操作状态。');

function serverPath(serverId: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(serverId))
		throw new WarconError('服务器编号配置不正确。', 'refused');
	return `/api/servers/${encodeURIComponent(serverId)}`;
}

function requireSteamId(steamId: string): void {
	if (!/^\d{17}$/.test(steamId)) throw new WarconError('SteamID 必须为 17 位数字。', 'refused');
}

function playersOf(value: unknown): GamePlayer[] {
	if (!object(value) || !Array.isArray(value.players) || value.players.length > 1000)
		throw malformed();
	const seen = new Set<string>();
	return value.players.map((player) => {
		if (
			!object(player) ||
			typeof player.steamId !== 'string' ||
			!/^\d{17}$/.test(player.steamId) ||
			seen.has(player.steamId) ||
			!text(player.name) ||
			!(player.faction === null || text(player.faction, 100)) ||
			!count(player.kills) ||
			!count(player.deaths) ||
			!(player.ping === null || (finite(player.ping) && player.ping >= 0))
		)
			throw malformed();
		seen.add(player.steamId);
		return {
			steamId: player.steamId,
			name: player.name,
			faction: player.faction,
			kills: player.kills,
			deaths: player.deaths,
			ping: player.ping
		};
	});
}

/** Only errors whose code and location prove the action was not dispatched can release a hold. */
function refusal(status: number, body: JsonObject, action?: string): boolean {
	if (status < 400 || status >= 500 || body.ok !== false || !object(body.error)) return false;
	const code = body.error.code;
	if (body.action !== undefined && body.action !== action) return false;
	if (body.error.upstreamStatus !== undefined) {
		// A game 4xx may be from a later step in a composite action. Do not infer no effect.
		return false;
	}
	return (
		(status === 401 &&
			['unauthenticated', 'invalid_api_key', 'api_key_expired', 'api_key_revoked'].includes(
				String(code)
			)) ||
		(status === 403 && ['forbidden', 'api_key_forbidden', 'suspended'].includes(String(code))) ||
		(status === 404 && ['not_found', 'unknown_action'].includes(String(code))) ||
		(status === 409 && code === 'same_side' && action === 'changeTeam') ||
		(status === 429 && code === 'rate_limited')
	);
}

/**
 * Uses only Warcon's scoped actions. Never retries writes: a timeout can follow a successful move.
 * Callers must retain an uncertain debit and reconcile it rather than grant a free second move.
 */
export class WarconClient implements WarconPort {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;
	private readonly fetch: Fetch;

	constructor(options: WarconClientOptions) {
		let base: URL;
		try {
			base = new URL(options.baseUrl);
		} catch {
			throw new Error('WARCON_BASE_URL 必须为完整的 HTTP(S) 地址。');
		}
		if (
			!['http:', 'https:'].includes(base.protocol) ||
			base.username ||
			base.password ||
			base.search ||
			base.hash
		)
			throw new Error('WARCON_BASE_URL 不得包含账号、密码、查询参数或片段。');
		if (!text(options.token, 4096) || /[\s\x00-\x1f\x7f]/.test(options.token))
			throw new Error('WARCON_TOKEN 配置不正确。');
		const timeoutMs = options.timeoutMs ?? 15_000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
			throw new Error('Warcon 请求超时必须介于 1 与 120000 毫秒之间。');
		this.baseUrl = base.toString().replace(/\/+$/, '');
		this.token = options.token;
		this.timeoutMs = timeoutMs;
		this.fetch = options.fetch ?? globalThis.fetch;
	}

	private async request(
		path: string,
		method: 'GET' | 'POST',
		params?: JsonObject,
		action?: string
	): Promise<JsonObject> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new WarconError('Warcon 请求超时，操作结果需要核对。'));
			}, this.timeoutMs);
		});
		try {
			return await Promise.race([
				(async () => {
					const response = await this.fetch(`${this.baseUrl}${path}`, {
						method,
						headers: {
							authorization: `Bearer ${this.token}`,
							accept: 'application/json',
							...(params ? { 'content-type': 'application/json' } : {})
						},
						body: params ? JSON.stringify(params) : undefined,
						redirect: 'error',
						signal: controller.signal
					});
					if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
						throw malformed();
					if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES)
						throw malformed();
					if (!response.body) throw malformed();
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let bodyText = '';
					let bytes = 0;
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							bytes += value.byteLength;
							if (bytes > MAX_RESPONSE_BYTES) throw malformed();
							bodyText += decoder.decode(value, { stream: true });
						}
						bodyText += decoder.decode();
					} finally {
						void reader.cancel().catch(() => {});
					}
					const body: unknown = JSON.parse(bodyText);
					if (!object(body)) throw malformed();
					if (!response.ok || body.ok !== true) {
						// Never repeat upstream text: it can echo a whisper, token or internal address.
						throw new WarconError(
							`Warcon 未确认操作成功（HTTP ${response.status}）。`,
							refusal(response.status, body, action) ? 'refused' : 'unknown'
						);
					}
					if (action && (body.action !== action || !object(body.result))) throw malformed();
					return body;
				})(),
				timeout
			]);
		} catch (error) {
			if (error instanceof WarconError) throw error;
			throw new WarconError('无法确认 Warcon 的响应，请稍后查询操作状态。');
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}

	private async action(serverId: string, action: string, params?: JsonObject): Promise<JsonObject> {
		const response = await this.request(
			`${serverPath(serverId)}/rcon/${action}`,
			params ? 'POST' : 'GET',
			params,
			action
		);
		return response.result as JsonObject;
	}

	async snapshot(serverId: string): Promise<GameSnapshot> {
		const observedAt = Date.now();
		const [status, roster, capabilities] = await Promise.all([
			this.action(serverId, 'status'),
			this.action(serverId, 'players'),
			this.action(serverId, 'capabilities')
		]);
		if (
			!text(status.map) ||
			!count(status.playerCount) ||
			!count(status.maxPlayers) ||
			!Array.isArray(status.scores) ||
			status.scores.length > 64 ||
			!object(capabilities.features) ||
			typeof capabilities.features.changeTeam !== 'boolean'
		)
			throw malformed();
		const names = new Set<string>();
		const scores = status.scores.map((score) => {
			if (!object(score) || !text(score.name, 100) || !finite(score.score) || names.has(score.name))
				throw malformed();
			names.add(score.name);
			return { name: score.name, score: score.score };
		});
		return {
			map: status.map,
			playerCount: status.playerCount,
			maxPlayers: status.maxPlayers,
			scores,
			players: playersOf(roster),
			observedAt,
			canMove: capabilities.features.changeTeam
		};
	}

	async whisper(serverId: string, steamId: string, message: string): Promise<void> {
		requireSteamId(steamId);
		if (!text(message, 256) || !message.trim())
			throw new WarconError('游戏私信必须为 1 至 256 个字符。', 'refused');
		const result = await this.action(serverId, 'whisper', { steamId, message, confidential: true });
		if (!text(result.message, 4096) || result.ok === false || result.error !== undefined)
			throw malformed();
	}

	async move(serverId: string, steamId: string, faction: string): Promise<void> {
		requireSteamId(steamId);
		if (!text(faction, 100) || faction.trim() !== faction)
			throw new WarconError('目标阵营配置不正确。', 'refused');
		const result = await this.action(serverId, 'changeTeam', { steamId, faction });
		if (
			!text(result.message, 4096) ||
			typeof result.respawned !== 'boolean' ||
			result.ok === false ||
			result.error !== undefined
		)
			throw malformed();
	}

	async reserved(serverId: string, steamId: string): Promise<ReservedStatus> {
		requireSteamId(steamId);
		const unknown: ReservedStatus = { state: 'unknown', expiresAt: null };
		try {
			const data = await this.request(`${serverPath(serverId)}/lists/state`, 'GET');
			if (!object(data.reserved) || !object(data.sync)) return unknown;
			const syncedAt =
				typeof data.sync.syncedAt === 'string' ? Date.parse(data.sync.syncedAt) : NaN;
			const age = Date.now() - syncedAt;
			if (
				!Number.isFinite(age) ||
				age < -60_000 ||
				age > LIST_MAX_AGE_MS ||
				data.sync.lastError !== ''
			)
				return unknown;
			if (!Object.hasOwn(data.reserved, steamId)) return { state: 'none', expiresAt: null };
			const slot = data.reserved[steamId];
			if (
				!object(slot) ||
				slot.managed !== true ||
				!['applied', 'pending'].includes(String(slot.state))
			)
				return unknown;
			const expiresAt = slot.expiresAt;
			if (
				expiresAt !== null &&
				(typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))
			)
				return unknown;
			if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) return unknown;
			return { state: slot.state === 'applied' ? 'active' : 'pending', expiresAt };
		} catch {
			// Balance queries can still succeed while the optional server list is unavailable.
			return unknown;
		}
	}
}
