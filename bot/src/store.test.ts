import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { BotStore } from './store';

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory() {
	const path = mkdtempSync(join(tmpdir(), 'warcon-bot-store-'));
	temporary.push(path);
	return path;
}
const STEAM = '76561198000000001';
function funded(store: BotStore) {
	store.beginBinding('c', 'q', STEAM, '123456', 1000);
	const binding = store.verifyBinding('c', 'q', '123456', 1001);
	store.checkin('c', 'q', '2026-10-23', 30, 1002);
	return binding;
}

describe('durable financial operations', () => {
	test('interrupted dispatch becomes unknown after reopen; human reconciliation refunds once', () => {
		const path = join(directory(), 'bot.sqlite');
		let store = new BotStore(path);
		const binding = funded(store);
		const confirmation = store.prepareMove(binding, 'server', 'Blue', 20, '234567', 1003);
		const operation = store.claimMove(confirmation.id, 300, 1004).operation;
		expect(store.balance('c', 'q')).toBe(10);
		store.close();
		store = new BotStore(path);
		expect(store.recoverInterrupted()).toBe(1);
		expect(store.recoverInterrupted()).toBe(0);
		expect(store.listUnknown()[0].id).toBe(operation.id);
		expect(() => store.assertCanMove('c', STEAM, 0, 999999)).toThrow('待管理员核实');
		store.resolveOperation(operation.id, 'refunded', '人工核实未执行', 2000);
		store.resolveOperation(operation.id, 'refunded', '重复提交', 2001);
		expect(store.balance('c', 'q')).toBe(30);
		expect(() => store.resolveOperation(operation.id, 'succeeded', '不可重写', 2002)).toThrow(
			'completed'
		);
		store.close();
	});
	test('online backup contains live WAL commits, bindings, ledger, and pending operations', () => {
		const folder = directory();
		const store = new BotStore(join(folder, 'live.sqlite'));
		const binding = funded(store);
		const confirmation = store.prepareMove(binding, 'server', 'Blue', 20, '234567', 1003);
		store.claimMove(confirmation.id, 300, 1004);
		const backup = join(folder, 'backup.sqlite');
		store.backup(backup);
		const restored = new BotStore(backup);
		expect(restored.binding('c', 'q')?.steamId).toBe(STEAM);
		expect(restored.balance('c', 'q')).toBe(10);
		expect(restored.recoverInterrupted()).toBe(1);
		expect(restored.listUnknown()).toHaveLength(1);
		expect(() => store.backup(backup)).toThrow();
		restored.close();
		store.close();
	});
	test('balance cannot go negative, failed debit leaves no operation, and ledger is append-only', () => {
		const path = join(directory(), 'bot.sqlite');
		const store = new BotStore(path);
		const binding = funded(store);
		const confirmation = store.prepareMove(binding, 'server', 'Blue', 31, '234567', 1003);
		expect(() => store.claimMove(confirmation.id, 300, 1004)).toThrow('积分不足');
		expect(store.balance('c', 'q')).toBe(30);
		expect(store.pending('c', STEAM)).toBeNull();
		const db = new Database(path);
		expect(db.query('SELECT COUNT(*) AS count FROM ledger').get()).toEqual({ count: 1 });
		expect(() => db.run('UPDATE ledger SET delta = 99')).toThrow('append-only');
		expect(() => db.run('DELETE FROM ledger')).toThrow('append-only');
		db.close();
		store.close();
	});
	test('two different accounts cannot verify ownership of the same SteamID', () => {
		const store = new BotStore(':memory:');
		store.beginBinding('c', 'first', STEAM, '123456', 1000);
		store.beginBinding('c', 'second', STEAM, '234567', 1000);
		store.verifyBinding('c', 'first', '123456', 1001);
		expect(() => store.verifyBinding('c', 'second', '234567', 1001)).toThrow('已被其他人绑定');
		expect(store.binding('c', 'second')).toBeNull();
		store.close();
	});
});
