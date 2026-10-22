import type { ManagedServer } from './admin-contracts';
import { WarconError, type WarconPort } from './contracts';
import { WarconClient } from './warcon';
import { DirectWardogsClient } from './wardogs';

export function serverClient(server: ManagedServer): WarconPort {
	return server.mode === 'wardogs'
		? new DirectWardogsClient(server)
		: new WarconClient({ baseUrl: server.warconUrl, token: server.warconToken });
}

/** Resolves only operator-configured servers. A settings edit invalidates in-flight observations. */
export class ManagedWarcon implements WarconPort {
	constructor(
		private settings: () => ManagedServer[],
		private revision: () => number,
		private factory: (server: ManagedServer) => WarconPort = serverClient
	) {}
	private client(id: string) {
		const server = this.settings().find((s) => s.id === id);
		if (!server) throw new WarconError('服务器尚未配置，请联系管理员。', 'refused');
		return this.factory(server);
	}
	async snapshot(id: string) {
		const revision = this.revision();
		const result = await this.client(id).snapshot(id);
		if (revision !== this.revision())
			throw new WarconError('服务器配置已更新，请重新发送命令。', 'refused');
		return result;
	}
	whisper(id: string, steamId: string, message: string) {
		return this.client(id).whisper(id, steamId, message);
	}
	move(id: string, steamId: string, faction: string) {
		return this.client(id).move(id, steamId, faction);
	}
	reserved(id: string, steamId: string) {
		return this.client(id).reserved(id, steamId);
	}
}
