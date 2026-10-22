import type { ManagedServer } from './admin-contracts';
import { WarconError, type GameSnapshot, type ReservedStatus, type WarconPort } from './contracts';

type JsonObject = Record<string, unknown>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface DirectWardogsOptions {
	fetch?: Fetch;
	timeoutMs?: number;
}

const MAX_BYTES = 1024 * 1024;
const object = (v: unknown): v is JsonObject =>
	v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string =>
	typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const count = (v: unknown): v is number =>
	typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const malformed = () => new WarconError('游戏服务器返回的数据不完整，操作结果需要核对。');
const steamIdValid = (v: unknown): v is string => typeof v === 'string' && /^\d{17}$/.test(v);

function requireSteamId(steamId: string) {
	if (!steamIdValid(steamId)) throw new WarconError('SteamID 必须为 17 位数字。', 'refused');
}

/** Only a recognized rejection of this individual HTTP operation is a known refusal. */
function refused(status: number, body: JsonObject): boolean {
	if (body.ok === true || !object(body.error)) return false;
	const code = body.error.code;
	return (
		(status === 401 && code === 'unauthorized') ||
		(status === 403 && code === 'forbidden') ||
		(status === 404 && ['player_not_found', 'not_found', 'no_route'].includes(String(code))) ||
		(status === 400 && code === 'invalid_faction') ||
		(status === 429 && code === 'rate_limited')
	);
}

/** Standalone RCON adapter. Credentials never leave its configured origin or appear in errors. */
export class DirectWardogsClient implements WarconPort {
	private readonly serverId: string;
	private readonly origin: string;
	private readonly password: string;
	private readonly fetch: Fetch;
	private readonly timeoutMs: number;

	constructor(server: ManagedServer, options: DirectWardogsOptions = {}) {
		if (server.mode !== 'wardogs' || !text(server.id, 128))
			throw new Error('直连客户端需要有效的 WARDOGS 服务器配置。');
		if (
			!['http', 'https'].includes(server.scheme) ||
			!text(server.host, 253) ||
			/[\s/@?#%\\]/.test(server.host) ||
			!Number.isInteger(server.port) ||
			server.port < 1 ||
			server.port > 65535
		)
			throw new Error('游戏服务器地址、协议或端口配置不正确。');
		const host =
			server.host.includes(':') && !server.host.startsWith('[') ? `[${server.host}]` : server.host;
		try {
			const url = new URL(`${server.scheme}://${host}:${server.port}`);
			if (url.pathname !== '/' || url.username || url.password || url.search || url.hash)
				throw new Error();
			this.origin = url.origin;
		} catch {
			throw new Error('游戏服务器地址配置不正确。');
		}
		if (!text(server.password, 4096) || /[\x00-\x1f\x7f]/.test(server.password))
			throw new Error('游戏服务器 RCON 密码配置不正确。');
		const timeoutMs = options.timeoutMs ?? 15_000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
			throw new Error('请求超时必须介于 1 与 120000 毫秒之间。');
		this.serverId = server.id;
		this.password = server.password;
		this.timeoutMs = timeoutMs;
		this.fetch = options.fetch ?? globalThis.fetch;
	}

	private assertServer(serverId: string) {
		if (serverId !== this.serverId)
			throw new WarconError('服务器配置与请求不一致，操作已取消。', 'refused');
	}

	private async request(
		method: 'GET' | 'POST' | 'PATCH',
		path: string,
		params?: JsonObject
	): Promise<JsonObject> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new WarconError('游戏服务器请求超时，操作结果需要核对。'));
			}, this.timeoutMs);
		});
		try {
			return await Promise.race([
				(async () => {
					const response = await this.fetch(`${this.origin}${path}`, {
						method,
						redirect: 'error',
						signal: controller.signal,
						headers: {
							authorization: `Bearer ${this.password}`,
							accept: 'application/json',
							...(params === undefined ? {} : { 'content-type': 'application/json' })
						},
						body: params === undefined ? undefined : JSON.stringify(params)
					});
					if (
						!response.headers.get('content-type')?.toLowerCase().includes('application/json') ||
						Number(response.headers.get('content-length')) > MAX_BYTES ||
						!response.body
					)
						throw malformed();
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let bytes = 0;
					let result = '';
					try {
						while (true) {
							const chunk = await reader.read();
							if (chunk.done) break;
							bytes += chunk.value.byteLength;
							if (bytes > MAX_BYTES) throw malformed();
							result += decoder.decode(chunk.value, { stream: true });
						}
						result += decoder.decode();
					} finally {
						void reader.cancel().catch(() => {});
					}
					const body: unknown = JSON.parse(result);
					if (!object(body)) throw malformed();
					if (
						!response.ok ||
						(body.ok !== undefined && body.ok !== true) ||
						body.error !== undefined
					)
						throw new WarconError(
							`游戏服务器未确认操作成功（HTTP ${response.status}）。`,
							!response.ok && refused(response.status, body) ? 'refused' : 'unknown'
						);
					return body;
				})(),
				timeout
			]);
		} catch (error) {
			if (error instanceof WarconError) throw error;
			// Upstream error text may echo the password or a binding code.
			throw new WarconError('无法确认游戏服务器的响应，请稍后查询操作状态。');
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}

	async snapshot(serverId: string): Promise<GameSnapshot> {
		this.assertServer(serverId);
		const observedAt = Date.now();
		const [status, roster, capabilities] = await Promise.all([
			this.request('GET', '/v1/status'),
			this.request('GET', '/v1/players'),
			this.request('GET', '/v1/capabilities')
		]);
		if (
			!text(status.map) ||
			!object(status.players) ||
			!count(status.players.current) ||
			!count(status.players.max) ||
			!Array.isArray(status.factionScores) ||
			status.factionScores.length > 64 ||
			!Array.isArray(roster.players) ||
			roster.players.length > 1000 ||
			!Array.isArray(capabilities.routes) ||
			capabilities.routes.length > 1000 ||
			!capabilities.routes.every((route) => text(route, 512))
		)
			throw malformed();
		const names = new Set<string>();
		const scores = status.factionScores.map((score) => {
			if (!object(score) || !text(score.name, 100) || !finite(score.score) || names.has(score.name))
				throw malformed();
			names.add(score.name);
			return { name: score.name, score: score.score };
		});
		const ids = new Set<string>();
		const players = roster.players.map((player) => {
			if (!object(player)) throw malformed();
			const faction = player.faction ?? null;
			const ping = player.pingMs ?? player.ping ?? null;
			if (
				!steamIdValid(player.steamId) ||
				ids.has(player.steamId) ||
				!text(player.name) ||
				!(faction === null || text(faction, 100)) ||
				!count(player.kills) ||
				!count(player.deaths) ||
				!(ping === null || (finite(ping) && ping >= 0))
			)
				throw malformed();
			ids.add(player.steamId);
			return {
				steamId: player.steamId,
				name: player.name,
				faction,
				kills: player.kills,
				deaths: player.deaths,
				ping
			};
		});
		const routes = capabilities.routes.map((route: string) =>
			route
				.trim()
				.replace(/\{[^}]*\}|:[^/\s]+/g, '*')
				.replace(/\s+/g, ' ')
		);
		return {
			map: status.map,
			playerCount: status.players.current,
			maxPlayers: status.players.max,
			scores,
			players,
			observedAt,
			canMove: routes.includes('PATCH /v1/players/*')
		};
	}

	async whisper(serverId: string, steamId: string, message: string): Promise<void> {
		this.assertServer(serverId);
		requireSteamId(steamId);
		if (!text(message, 256)) throw new WarconError('游戏私信必须为 1 至 256 个字符。', 'refused');
		const response = await this.request('POST', `/v1/players/${steamId}/message`, { message });
		if (!text(response.message, 4096)) throw malformed();
	}

	async move(serverId: string, steamId: string, faction: string): Promise<void> {
		this.assertServer(serverId);
		requireSteamId(steamId);
		if (!text(faction, 100) || faction.trim() !== faction)
			throw new WarconError('目标阵营配置不正确。', 'refused');
		const response = await this.request('PATCH', `/v1/players/${steamId}`, { faction });
		if (!text(response.message, 4096)) throw malformed();
		// The move is already confirmed. A missing character, refusal, timeout or malformed kill
		// response must never refund a completed move. Do not retry either request.
		try {
			await this.request('POST', `/v1/players/${steamId}/kill`);
		} catch {
			/* Keep the successful move. */
		}
	}

	async reserved(serverId: string, steamId: string): Promise<ReservedStatus> {
		this.assertServer(serverId);
		requireSteamId(steamId);
		const unknown: ReservedStatus = { state: 'unknown', expiresAt: null };
		try {
			const body = await this.request('GET', '/v1/reserved-slots');
			if (
				!Array.isArray(body.reservedSlots) ||
				body.reservedSlots.length > 100000 ||
				!body.reservedSlots.every(steamIdValid)
			)
				return unknown;
			// The native API lists configured IDs but has no expiry or synchronization metadata.
			// A present entry cannot establish a permanent/effective entitlement in this contract.
			return body.reservedSlots.includes(steamId) ? unknown : { state: 'none', expiresAt: null };
		} catch {
			return unknown;
		}
	}
}
