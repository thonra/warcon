import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeLock } from './runtime-lock';

test('runtime cannot steal a live lock and can restart after SIGKILL', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'qq-lock-'));
	const path = join(dir, 'state.sqlite');
	const helper = new URL('./runtime-lock.ts', import.meta.url).pathname;
	const proc = Bun.spawn(
		[
			process.execPath,
			'--no-env-file',
			'-e',
			`import { runtimeLock } from ${JSON.stringify(helper)}; globalThis.releaseLock = runtimeLock(${JSON.stringify(path)}); console.log('locked'); setInterval(()=>{},1000);`
		],
		{ stdout: 'pipe', stderr: 'pipe' }
	);
	try {
		const reader = proc.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain('locked');
		expect(() => runtimeLock(path)).toThrow('已有机器人');
		proc.kill('SIGKILL');
		await proc.exited;
		const release = runtimeLock(path);
		release();
		const again = runtimeLock(path);
		again();
	} finally {
		proc.kill();
		await proc.exited;
		rmSync(dir, { recursive: true, force: true });
	}
});
