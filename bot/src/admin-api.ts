import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AdminStore, AdminValidationError, AdminConflictError } from './admin-store';
import { BotStore } from './store';
import type { ManagedServer, SettingsUpdate } from './admin-contracts';

export interface AdminHooks {
	/** Fixed operator-configured browser origin for TLS termination; never inferred from proxy headers. */
	publicOrigin?: string;
	onSettingsChanged: () => void;
	testServer: (
		server: ManagedServer
	) => Promise<{ map: string; playerCount: number; factions: string[] }>;
	/** Private temporary directory. Every completed download removes its snapshot. */
	backupPath: string;
	selfId: string;
	inboxStats: () => Record<string, number>;
}
const COOKIE = 'warcon_bot_admin';
const MAX_BODY = 65_536;
class ApiFailure extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}
function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
	return Response.json(data, {
		status,
		headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }
	});
}
function tokenFrom(request: Request) {
	const matches = (request.headers.get('cookie') ?? '')
		.split(';')
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${COOKIE}=`));
	return matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : '';
}
function cookie(token: string, secure: boolean, clear = false) {
	return `${COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 43_200}${secure ? '; Secure' : ''}`;
}
async function body(request: Request): Promise<Record<string, unknown>> {
	if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
		throw new ApiFailure(415, '请提交JSON请求。');
	const length = Number(request.headers.get('content-length'));
	if (length > MAX_BODY) throw new ApiFailure(413, '请求内容过大。');
	const reader = request.body?.getReader();
	if (!reader) throw new ApiFailure(400, '请求内容为空。');
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_BODY) {
			await reader.cancel();
			throw new ApiFailure(413, '请求内容过大。');
		}
		chunks.push(value);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
		return parsed;
	} catch {
		throw new ApiFailure(400, 'JSON格式无效。');
	}
}

export class AdminApi {
	private loginAttempts: number[] = [];
	private loginInFlight = 0;
	private lastBackupAt = 0;
	constructor(
		private readonly store: AdminStore,
		private readonly botStore: BotStore,
		private readonly hooks: AdminHooks
	) {}
	async handle(request: Request): Promise<Response | null> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith('/admin/api/')) return null;
		try {
			const path = url.pathname.slice('/admin/api'.length);
			if (path === '/login' && request.method === 'POST') {
				this.sameOrigin(request, url);
				const now = Date.now();
				this.loginAttempts = this.loginAttempts.filter((at) => at > now - 900_000);
				// Bound both credential guessing and concurrent Argon2 memory use. No spoofable proxy IP is trusted.
				if (this.loginAttempts.length >= 20 || this.loginInFlight >= 2)
					throw new ApiFailure(429, '登录尝试过于频繁，请稍后再试。');
				this.loginAttempts.push(now);
				const data = await body(request);
				if (
					typeof data.username !== 'string' ||
					data.username.length > 64 ||
					typeof data.password !== 'string' ||
					data.password.length > 256
				)
					throw new ApiFailure(400, '用户名或密码格式无效。');
				if (this.loginInFlight >= 2) throw new ApiFailure(429, '登录尝试过于频繁，请稍后再试。');
				this.loginInFlight++;
				try {
					const result = await this.store.login(data.username, data.password);
					if (!result) throw new ApiFailure(401, '用户名或密码不正确。');
					return json(
						{ ok: true, username: result.session.username, csrf: result.session.csrf },
						200,
						{ 'set-cookie': cookie(result.token, this.expectedOrigin(url).startsWith('https:')) }
					);
				} finally {
					this.loginInFlight--;
				}
			}
			const token = tokenFrom(request);
			const session = this.store.session(token);
			if (!session) throw new ApiFailure(401, '请先登录管理后台。');
			if (!['GET', 'HEAD'].includes(request.method)) {
				this.sameOrigin(request, url);
				if (!this.store.checkCsrf(session, request.headers.get('x-csrf-token') ?? ''))
					throw new ApiFailure(403, '安全校验已失效，请刷新页面后重试。');
			}
			if (path === '/session' && request.method === 'GET')
				return json({ ok: true, username: session.username, csrf: session.csrf });
			if (path === '/logout' && request.method === 'POST') {
				this.store.logout(token);
				return json({ ok: true }, 200, {
					'set-cookie': cookie('', this.expectedOrigin(url).startsWith('https:'), true)
				});
			}
			if (path === '/config' && request.method === 'GET')
				return json({ ok: true, ...this.store.publicSettings() });
			if (path === '/config' && request.method === 'PUT') {
				const data = await body(request);
				const settings = this.store.saveSettings(
					data as unknown as SettingsUpdate,
					session.username
				);
				this.hooks.onSettingsChanged();
				return json({ ok: true, ...settings });
			}
			if (path === '/test-server' && request.method === 'POST') {
				const data = await body(request);
				const server = this.store.getSettings().servers.find((item) => item.id === data.id);
				if (!server) throw new ApiFailure(404, '服务器配置不存在，请先保存配置。');
				try {
					const result = await this.hooks.testServer(server);
					return json({
						ok: true,
						map: result.map,
						playerCount: result.playerCount,
						factions: result.factions
					});
				} catch {
					throw new ApiFailure(502, '连接测试失败，请检查地址、端口、密码及网络访问权限。');
				}
			}
			if (path === '/overview' && request.method === 'GET')
				return json({
					ok: true,
					accounts: this.botStore.listAccounts(),
					operations: this.botStore.listOperations(),
					inbox: this.hooks.inboxStats(),
					selfId: this.hooks.selfId
				});
			const operationMatch = path.match(/^\/operations\/([a-zA-Z0-9-]{1,80})\/resolve$/);
			if (operationMatch && request.method === 'POST') {
				const data = await body(request);
				if (
					(data.outcome !== 'succeeded' && data.outcome !== 'refunded') ||
					typeof data.reason !== 'string' ||
					data.reason.trim().length < 5 ||
					data.reason.trim().length > 500
				)
					throw new ApiFailure(400, '请选择处理结果，并填写5至500个字符的核对理由。');
				const operation = this.botStore.operation(operationMatch[1]);
				if (!operation) throw new ApiFailure(404, '订单不存在。');
				if (operation.state !== 'unknown')
					throw new ApiFailure(409, '只能核实结果未知的订单，处理中或已完成的订单不能修改。');
				const resolved = this.botStore.resolveOperation(
					operation.id,
					data.outcome,
					`管理员 ${session.username}：${data.reason.trim()}`
				);
				this.store.audit(session.username, `operation.${operation.id}.${data.outcome}`);
				return json({ ok: true, operation: resolved });
			}
			if (path === '/backup' && request.method === 'GET') {
				if (Date.now() - this.lastBackupAt < 10_000)
					throw new ApiFailure(429, '备份请求过于频繁，请稍候重试。');
				this.lastBackupAt = Date.now();
				mkdirSync(this.hooks.backupPath, { recursive: true, mode: 0o700 });
				const path = join(this.hooks.backupPath, `warcon-bot-${randomUUID()}.sqlite`);
				try {
					this.botStore.backup(path);
					const bytes = readFileSync(path);
					this.store.audit(session.username, 'backup.downloaded');
					return new Response(bytes, {
						headers: {
							'content-type': 'application/vnd.sqlite3',
							'content-disposition': `attachment; filename="warcon-bot-${new Date().toISOString().slice(0, 10)}.sqlite"`,
							'cache-control': 'no-store',
							'x-content-type-options': 'nosniff'
						}
					});
				} finally {
					rmSync(path, { force: true });
				}
			}
			throw new ApiFailure(404, '管理接口不存在。');
		} catch (error) {
			if (error instanceof AdminConflictError)
				return json({ ok: false, error: error.message, code: 'configuration_conflict' }, 409);
			if (error instanceof ApiFailure)
				return json({ ok: false, error: error.message }, error.status);
			if (error instanceof AdminValidationError)
				return json({ ok: false, error: error.message }, 400);
			return json({ ok: false, error: '操作暂时失败，请检查服务运行状态后重试。' }, 500);
		}
	}
	private expectedOrigin(url: URL): string {
		return this.hooks.publicOrigin ?? url.origin;
	}
	private sameOrigin(request: Request, url: URL) {
		if (request.headers.get('origin') !== this.expectedOrigin(url))
			throw new ApiFailure(403, '请求来源不受信任，请从管理后台页面操作。');
	}
}
