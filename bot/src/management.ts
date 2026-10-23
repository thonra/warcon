import type { BotHandler, BotMessage, GroupConfig } from './contracts';
import { WarconError } from './contracts';
import { ManagerStore, managerActor } from './manager-store';
import { MANAGEMENT_COMMANDS, managementInput } from './management-catalog';
import { renderReply, type ReplyOverrides } from './reply-copy';
export interface ManagementPort {
	prepare(
		serverId: string,
		command: string,
		args: string,
		group: GroupConfig
	): Promise<{ expected: string; summary: string }>;
	execute(
		serverId: string,
		command: string,
		args: string,
		group: GroupConfig,
		expected: string,
		guard: () => void
	): Promise<string>;
	read(serverId: string, command: string, args: string, group: GroupConfig): Promise<string>;
}
export class ManagementInputError extends Error {}
export class ManagementHandler {
	constructor(
		private store: ManagerStore,
		private remote: ManagementPort,
		private revision: () => string | undefined,
		private replies: () => ReplyOverrides = () => ({}),
		private now = Date.now
	) {}
	private text(
		key: 'admin.denied' | 'admin.failed' | 'admin.changed',
		values: Record<string, string | number> = {}
	) {
		return renderReply(key, values, this.replies());
	}
	async handle(m: BotMessage, g: GroupConfig): Promise<string | null> {
		const input = managementInput(m.text);
		if (!input) return null;
		if (
			m.groupId !== g.groupId ||
			m.configurationRevision !== this.revision() ||
			Math.abs(this.now() - m.time) > 120000
		)
			return this.text('admin.changed');
		if (input.name === '管理身份') {
			try {
				return renderReply(
					'admin.identity',
					{ code: this.store.challenge(m, this.now()) },
					this.replies()
				);
			} catch {
				return this.text('admin.failed');
			}
		}
		const manager = this.store.authorize(m, g.serverId);
		if (!manager) {
			this.store.audit('', g.serverId, input.name, 'denied');
			return this.text('admin.denied');
		}
		const guard = () => {
			if (m.configurationRevision !== this.revision() || !this.store.authorize(m, g.serverId))
				throw new ManagementInputError('配置或管理权限已变化，请重新发送命令');
		};
		try {
			if (input.name === '管理帮助') {
				const selected = MANAGEMENT_COMMANDS.filter(
					(x) => !input.args || x.category === input.args
				);
				if (!input.args)
					return renderReply(
						'admin.help',
						{
							commands: [...new Set(MANAGEMENT_COMMANDS.map((x) => x.category))]
								.map(
									(c) =>
										c +
										'：' +
										MANAGEMENT_COMMANDS.filter((x) => x.category === c)
											.map((x) => '/' + x.name)
											.join('、')
								)
								.join('\n')
						},
						this.replies()
					);
				return selected.length
					? selected
							.map((x) => '/' + x.name + (x.usage ? ' ' + x.usage : '') + '\n' + x.description)
							.join('\n\n')
					: '没有这个分类，可查看 /管理帮助';
			}
			if (input.name === '管理记录')
				return (
					this.store
						.recent(g.serverId)
						.slice(0, 10)
						.map((x) => `${x.command} · ${x.state}\n${x.id}`)
						.join('\n') || '暂无管理操作'
				);
			if (input.name === '执行' || input.name === '取消管理') {
				if (!/^[a-f0-9]{8}$/.test(input.args)) return '请提供8位管理确认码';
				const op = this.store.operation(m, g.serverId, input.args);
				if (!op) return '没有找到当前会话中属于你的管理确认码';
				if (op.state !== 'pending') return op.result || '操作正在处理中，请勿重复提交';
				if (input.name === '取消管理') {
					this.store.finish(op.id, 'cancelled', '已取消管理操作');
					return '已取消管理操作';
				}
				if (
					op.expiresAt <= this.now() ||
					op.configRevision !== this.revision() ||
					op.policyRevision !== this.store.policy().revision
				) {
					this.store.finish(op.id, 'cancelled', '确认已过期或权限配置已变化，请重新发起');
					return '确认已过期或权限配置已变化，请重新发起';
				}
				const current = await this.remote.prepare(g.serverId, op.command, op.args, g);
				guard();
				if (current.expected !== op.expected) {
					this.store.finish(op.id, 'cancelled', '目标配置已变化，请重新发起并核对');
					return '目标配置已变化，请重新发起并核对';
				}
				if (!this.store.claim(op.id)) return '操作正在处理中，请勿重复提交';
				try {
					const result = await this.remote.execute(
						g.serverId,
						op.command,
						op.args,
						g,
						op.expected,
						guard
					);
					const reply = renderReply('admin.success', { result, orderId: op.id }, this.replies());
					this.store.finish(op.id, 'succeeded', reply);
					this.store.audit(manager.qq, g.serverId, op.command, 'succeeded');
					return reply;
				} catch (error) {
					const refused =
						error instanceof ManagementInputError ||
						(error instanceof WarconError && error.effect === 'refused');
					const reply = refused
						? '操作未执行，请核对参数、权限或配置后重新发起\n记录：' + op.id
						: renderReply('admin.unknown', { orderId: op.id }, this.replies());
					this.store.finish(op.id, refused ? 'refused' : 'unknown', reply);
					this.store.audit(manager.qq, g.serverId, op.command, refused ? 'refused' : 'unknown');
					return reply;
				}
			}
			const def = MANAGEMENT_COMMANDS.find((x) => x.name === input.name)!;
			if (!def.write) {
				const result = await this.remote.read(g.serverId, input.name, input.args, g);
				guard();
				this.store.audit(manager.qq, g.serverId, input.name, 'read');
				return result;
			}
			const preview = await this.remote.prepare(g.serverId, input.name, input.args, g);
			guard();
			const unknown = this.store.uncertain(managerActor(m)!, g.serverId, input.name, input.args);
			if (unknown) return '同一操作的结果仍待核实，请先在后台记录核实结果\n记录：' + unknown.id;
			const quote = this.store.quote(
				m,
				manager,
				g.serverId,
				input.name,
				input.args,
				preview.expected,
				preview.summary,
				this.now()
			);
			return renderReply(
				'admin.quote',
				{ serverName: g.serverName, summary: preview.summary, code: quote.code },
				this.replies()
			);
		} catch (error) {
			if (error instanceof ManagementInputError) return error.message;
			this.store.audit(manager.qq, g.serverId, input.name, 'error');
			return this.text('admin.failed');
		}
	}
}
