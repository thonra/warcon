import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runtimeLock } from './runtime-lock';
import { loadConfig } from './config';
import { BotStore } from './store';
import { CommandHandler } from './commands';
import { WarconClient } from './warcon';
import { Inbox } from './inbox';
import { NapCatBot } from './napcat';
import { AdminStore } from './admin-store';
import { AdminApi } from './admin-api';
import { adminPage } from './admin-page';
import { ManagedWarcon, serverClient } from './managed-warcon';
import type { ManagedSettings } from './admin-contracts';
import type { WarconPort } from './contracts';
import { randomUUID } from 'node:crypto';

async function main(): Promise<void> {
	process.umask(0o077);
	const command = process.argv[2];
	const path = resolve(process.env.QQ_BOT_DB ?? './data/qq-bot.sqlite');
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// Local operator tools; never reachable from QQ. Backup can run while the service is live.
	if (command === 'backup') {
		if (!process.argv[3] || !existsSync(path))
			throw new Error('用法：backup <新备份文件路径>；原数据库必须存在。');
		const store = new BotStore(path);
		try {
			await store.backup(resolve(process.argv[3]));
			console.log('备份完成。');
		} finally {
			store.close();
		}
		return;
	}
	if (command && command !== 'unknown' && command !== 'resolve')
		throw new Error('支持命令：backup / unknown / resolve；无参数启动服务。');
	if (command && !existsSync(path)) throw new Error('数据库不存在。');
	const config = command ? null : loadConfig();
	if (config) config.revision = randomUUID();
	const release = runtimeLock(path);
	let store: BotStore | undefined;
	let inbox: Inbox | undefined;
	let adminStore: AdminStore | undefined;
	try {
		store = new BotStore(path);
		store.recoverInterrupted();
		if (command === 'unknown') {
			console.log(JSON.stringify(store.listUnknown(), null, 2));
			return;
		}
		if (command === 'resolve') {
			const [id, outcome, ...reason] = process.argv.slice(3);
			if (!id || !['succeeded', 'refunded'].includes(outcome) || !reason.join(' ').trim())
				throw new Error(
					'停服并核对 Warcon 审计后使用：resolve <操作ID> succeeded|refunded <核对理由>'
				);
			store.resolveOperation(id, outcome as 'succeeded' | 'refunded', reason.join(' '));
			console.log('已记录核对结果。');
			return;
		}
		inbox = new Inbox(path);
		inbox.recover();
		let warcon: WarconPort;
		let admin: AdminApi | undefined;
		if (config!.managed) {
			const auth = config!.managed;
			adminStore = new AdminStore(path, auth.masterKey);
			await adminStore.initialize(auth.username, auth.password);
			let current: ManagedSettings = adminStore.getSettings();
			let revision = 0;
			config!.groups = current.groups;
			warcon = new ManagedWarcon(
				() => current.servers,
				() => revision
			);
			admin = new AdminApi(adminStore, store, {
				publicOrigin: auth.origin,
				onSettingsChanged: () => {
					current = adminStore!.getSettings();
					config!.groups = current.groups;
					config!.revision = randomUUID();
					revision++;
					store!.invalidateConfirmations();
				},
				testServer: async (server) => {
					const view = await serverClient(server).snapshot(server.id);
					return {
						map: view.map,
						playerCount: view.playerCount,
						factions: view.scores.map((s) => s.name)
					};
				},
				backupPath: resolve(dirname(path), 'backups'),
				selfId: config!.selfId,
				inboxStats: () => inbox!.stats()
			});
		} else warcon = new WarconClient({ baseUrl: config!.warconUrl, token: config!.warconToken });
		const bot = new NapCatBot(
			config!,
			inbox,
			new CommandHandler(store, warcon, { configurationRevision: () => config!.revision })
		);
		const server = Bun.serve({
			hostname: config!.host,
			port: config!.port,
			maxRequestBodySize: 65536,
			fetch: async (request) => {
				const route = new URL(request.url).pathname;
				if (
					admin &&
					request.method === 'GET' &&
					(route === '/' || route === '/admin' || route === '/admin/')
				) {
					return new Response(adminPage(), {
						headers: {
							'content-type': 'text/html; charset=utf-8',
							'cache-control': 'no-store',
							'x-content-type-options': 'nosniff',
							'content-security-policy':
								"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
						}
					});
				}
				return (await admin?.handle(request)) ?? bot.receive(request);
			}
		});
		const timer = setInterval(() => {
			void bot.pump().catch(() => console.error('消息处理异常，请检查本地记录。'));
		}, 250);
		const cleanup = setInterval(() => inbox!.prune(Date.now()), 3600000);
		console.log(
			`Warcon QQ 机器人已监听 ${config!.host}:${config!.port}，已配置 ${config!.groups.length} 个群。`
		);
		await new Promise<void>((done) => {
			const stop = () => {
				process.off('SIGINT', stop);
				process.off('SIGTERM', stop);
				done();
			};
			process.on('SIGINT', stop);
			process.on('SIGTERM', stop);
		});
		clearInterval(timer);
		clearInterval(cleanup);
		await server.stop(true);
		await bot.pump();
	} finally {
		adminStore?.close();
		inbox?.close();
		store?.close();
		release();
	}
}

if (import.meta.main)
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : '启动失败。');
		process.exitCode = 1;
	});
