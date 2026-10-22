import { Database } from 'bun:sqlite';

/** OS-held lock, released even on SIGKILL/PID reuse/container restart. Keep this file on local disk. */
export function runtimeLock(path: string): () => void {
	const lock = new Database(path + '.runtime-lock', { create: true });
	try {
		lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
	} catch {
		lock.close();
		throw new Error('已有机器人进程使用这个数据库。请先停服，再核对或处理异常订单。');
	}
	return () => {
		lock.exec('ROLLBACK');
		lock.close();
	};
}
