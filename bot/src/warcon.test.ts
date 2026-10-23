import { describe, expect, test } from 'bun:test';
import { WarconClient } from './warcon';

const STEAM = '76561198000000001';
const SERVER = 'server-1';
const TOKEN = 'test-warcon-key';
const PLAYER = { steamId: STEAM, name: '玩家', faction: 'BLU', kills: 4, deaths: 2, ping: 80 };
const STATUS = {
	map: 'Bakurani',
	playerCount: 1,
	maxPlayers: 100,
	scores: [{ name: 'BLU', score: 20, colorHex: '#0000ff' }]
};
type Call = { url: string; init: RequestInit };
function json(value: unknown, status = 200) {
	return Response.json(value, { status });
}
function success(action: string, result: unknown) {
	return json({ ok: true, action, role: 'Bot', result, durationMs: 8 });
}
function fixture(respond?: (action: string, call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const client = new WarconClient({
		baseUrl: 'https://warcon.example/',
		token: TOKEN,
		fetch: async (input, init = {}) => {
			const call = { url: String(input), init };
			calls.push(call);
			const action = new URL(call.url).pathname.split('/').at(-1)!;
			if (respond) return respond(action, call);
			const values: Record<string, unknown> = {
				status: STATUS,
				players: { players: [PLAYER] },
				capabilities: { features: { changeTeam: true } },
				whisper: { message: 'Message sent.' },
				changeTeam: { message: 'Moved to GRN.', respawned: true }
			};
			return success(action, values[action]);
		}
	});
	return { client, calls };
}

describe('圣女千夜的教堂 scoped adapter', () => {
	test('reads fresh snapshots directly and preserves string Steam IDs', async () => {
		const { client, calls } = fixture();
		const before = Date.now();
		const snapshot = await client.snapshot(SERVER);
		expect(snapshot).toEqual({
			map: 'Bakurani',
			playerCount: 1,
			maxPlayers: 100,
			scores: [{ name: 'BLU', score: 20 }],
			players: [PLAYER],
			canMove: true,
			observedAt: expect.any(Number)
		});
		expect(snapshot.observedAt).toBeGreaterThanOrEqual(before);
		expect(snapshot.observedAt).toBeLessThanOrEqual(Date.now());
		expect(calls.map((call) => call.url)).toEqual([
			'https://warcon.example/api/servers/server-1/rcon/status',
			'https://warcon.example/api/servers/server-1/rcon/players',
			'https://warcon.example/api/servers/server-1/rcon/capabilities'
		]);
		for (const { init } of calls) {
			expect(init.method).toBe('GET');
			expect(init.redirect).toBe('error');
			expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
		}
		await client.snapshot(SERVER);
		expect(calls.length).toBe(6); // A second read is never a cached /api/live result.
	});

	test('snapshot timestamp is the start of observation, not its later completion', async () => {
		let started = 0;
		const { client } = fixture(async (action) => {
			if (!started) started = Date.now();
			await new Promise((resolve) => setTimeout(resolve, 15));
			return success(
				action,
				action === 'status'
					? STATUS
					: action === 'players'
						? { players: [PLAYER] }
						: { features: { changeTeam: false } }
			);
		});
		const snapshot = await client.snapshot(SERVER);
		expect(snapshot.observedAt).toBeLessThanOrEqual(started);
		expect(snapshot.canMove).toBe(false);
	});

	test.each([
		['players', { players: [{ ...PLAYER, steamId: 76561198000000001 }] }],
		['players', { players: [PLAYER, PLAYER] }],
		['players', { players: [{ ...PLAYER, kills: '4' }] }],
		['players', { players: [{ ...PLAYER, ping: -1 }] }],
		['status', { ...STATUS, playerCount: '1' }],
		['status', { ...STATUS, scores: [{ name: 'BLU', score: '20' }] }],
		['status', { ...STATUS, scores: [STATUS.scores[0], STATUS.scores[0]] }],
		['capabilities', { features: { changeTeam: 'true' } }]
	])('rejects malformed %s snapshot data', async (badAction, value) => {
		const { client } = fixture((action) =>
			success(
				action,
				action === badAction
					? value
					: action === 'status'
						? STATUS
						: action === 'players'
							? { players: [PLAYER] }
							: { features: { changeTeam: true } }
			)
		);
		await expect(client.snapshot(SERVER)).rejects.toMatchObject({ effect: 'unknown' });
	});

	test('sends private verification messages and moves only through scoped POST actions', async () => {
		const { client, calls } = fixture();
		await client.whisper(SERVER, STEAM, '验证口令 123456');
		await client.move(SERVER, STEAM, 'GRN');
		expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
			'/api/servers/server-1/rcon/whisper',
			'/api/servers/server-1/rcon/changeTeam'
		]);
		expect(calls.map(({ init }) => init.method)).toEqual(['POST', 'POST']);
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			steamId: STEAM,
			message: '验证口令 123456',
			confidential: true
		});
		expect(JSON.parse(String(calls[1].init.body))).toEqual({ steamId: STEAM, faction: 'GRN' });
	});

	test('a successful move without a respawn still succeeds and is not repeated', async () => {
		const { client, calls } = fixture((action) =>
			success(action, { message: 'Moved; no living character.', respawned: false })
		);
		await client.move(SERVER, STEAM, 'GRN');
		expect(calls.length).toBe(1);
	});

	test.each([
		{},
		{ ok: true, action: 'whisper', result: { message: 'OK', respawned: true } },
		{ ok: true, action: 'changeTeam', result: {} },
		{ ok: true, action: 'changeTeam', result: { message: 'OK' } },
		{ ok: true, action: 'changeTeam', result: { message: 'OK', respawned: true, ok: false } },
		{ ok: true, action: 'changeTeam', result: { message: 'OK', respawned: true, error: {} } }
	])('does not treat a malformed move response as success: %j', async (body) => {
		const { client, calls } = fixture(() => json(body));
		await expect(client.move(SERVER, STEAM, 'GRN')).rejects.toMatchObject({ effect: 'unknown' });
		expect(calls.length).toBe(1);
	});

	test('does not treat a malformed whisper response as sent', async () => {
		const { client } = fixture((action) => success(action, {}));
		await expect(client.whisper(SERVER, STEAM, '秘密')).rejects.toMatchObject({
			effect: 'unknown'
		});
	});

	test.each([
		[401, 'invalid_api_key'],
		[401, 'unauthenticated'],
		[401, 'api_key_expired'],
		[401, 'api_key_revoked'],
		[403, 'forbidden'],
		[403, 'suspended'],
		[404, 'not_found'],
		[404, 'unknown_action'],
		[409, 'same_side'],
		[429, 'rate_limited']
	])('classifies known pre-dispatch refusal %i %s without a retry', async (status, code) => {
		const { client, calls } = fixture(() =>
			json({ ok: false, error: { code, message: 'private upstream text' } }, status)
		);
		await expect(client.move(SERVER, STEAM, 'GRN')).rejects.toMatchObject({ effect: 'refused' });
		expect(calls.length).toBe(1);
	});

	test.each([
		[500, { code: 'internal' }],
		[503, { code: 'server_busy' }],
		[504, { code: 'server_busy' }],
		[404, { code: 'player_not_found', upstreamStatus: 404 }],
		[429, { code: 'rate_limited', upstreamStatus: 429 }],
		[409, { code: 'unexpected_conflict' }],
		[400, {}]
	])('retains uncertainty for %i %j and never retries', async (status, error) => {
		const { client, calls } = fixture(() => json({ ok: false, error }, status));
		await expect(client.move(SERVER, STEAM, 'GRN')).rejects.toMatchObject({ effect: 'unknown' });
		expect(calls.length).toBe(1);
	});

	test('does not expose error text which may contain a verification code or token', async () => {
		const { client } = fixture(() =>
			json({ ok: false, error: { code: 'error', message: '123456 super-secret' } }, 500)
		);
		try {
			await client.whisper(SERVER, STEAM, '123456');
			throw new Error('expected rejection');
		} catch (error) {
			expect(String(error)).not.toContain('123456');
			expect(String(error)).not.toContain('super-secret');
		}
	});

	test('rejects an HTML proxy page, invalid JSON and oversized JSON', async () => {
		for (const response of [
			new Response('<h1>Proxy error</h1>', { headers: { 'content-type': 'text/html' } }),
			new Response('{', { headers: { 'content-type': 'application/json' } }),
			json({ ok: true, padding: 'x'.repeat(1024 * 1024) })
		]) {
			const { client, calls } = fixture(() => response);
			await expect(client.move(SERVER, STEAM, 'GRN')).rejects.toMatchObject({ effect: 'unknown' });
			expect(calls.length).toBe(1);
		}
	});

	test('aborts a timed out request and keeps the effect uncertain', async () => {
		let calls = 0;
		let signal: AbortSignal | undefined;
		const client = new WarconClient({
			baseUrl: 'http://localhost:3000',
			token: TOKEN,
			timeoutMs: 10,
			fetch: async (_, init) => {
				calls++;
				signal = init?.signal ?? undefined;
				return new Promise(() => {});
			}
		});
		await expect(client.move(SERVER, STEAM, 'GRN')).rejects.toMatchObject({ effect: 'unknown' });
		expect(calls).toBe(1);
		expect(signal?.aborted).toBe(true);
	});

	test('never retries a connection failure or follows a redirect', async () => {
		const { client, calls } = fixture(() => {
			throw new Error('network failure');
		});
		await expect(client.move(SERVER, STEAM, 'GRN')).rejects.toMatchObject({ effect: 'unknown' });
		expect(calls.length).toBe(1);
		expect(calls[0].init.redirect).toBe('error');
	});

	test('refuses invalid parameters before any request', async () => {
		const { client, calls } = fixture();
		await expect(client.move('../other-server', STEAM, 'GRN')).rejects.toMatchObject({
			effect: 'refused'
		});
		await expect(client.move(SERVER, 'not-steam', 'GRN')).rejects.toMatchObject({
			effect: 'refused'
		});
		await expect(client.move(SERVER, STEAM, ' GRN')).rejects.toMatchObject({ effect: 'refused' });
		await expect(client.whisper(SERVER, STEAM, 'x'.repeat(257))).rejects.toMatchObject({
			effect: 'refused'
		});
		expect(calls.length).toBe(0);
	});

	test.each([
		'file:///tmp/warcon',
		'https://user:pass@warcon.example',
		'https://warcon.example/?token=private',
		'https://warcon.example/#private',
		'not a url'
	])('refuses unsafe base URL %s', (baseUrl) => {
		expect(() => new WarconClient({ baseUrl, token: TOKEN })).toThrow();
	});
});

describe('reserved slot display', () => {
	function listFixture(
		slot?: unknown,
		sync: unknown = { syncedAt: new Date().toISOString(), lastError: '' }
	) {
		return fixture(() =>
			json({ ok: true, reserved: slot === undefined ? {} : { [STEAM]: slot }, sync })
		);
	}
	test('reads only the bound player from the scoped server list and preserves expiry', async () => {
		const expiresAt = new Date(Date.now() + 86400_000).toISOString();
		const { client, calls } = listFixture({ state: 'applied', managed: true, expiresAt });
		expect(await client.reserved(SERVER, STEAM)).toEqual({ state: 'active', expiresAt });
		expect(calls[0].url).toBe('https://warcon.example/api/servers/server-1/lists/state');
		expect(calls[0].init.method).toBe('GET');
	});

	test('distinguishes absent, pending and permanent managed entitlement', async () => {
		expect(await listFixture().client.reserved(SERVER, STEAM)).toEqual({
			state: 'none',
			expiresAt: null
		});
		expect(
			await listFixture({ state: 'pending', managed: true, expiresAt: null }).client.reserved(
				SERVER,
				STEAM
			)
		).toEqual({ state: 'pending', expiresAt: null });
		expect(
			await listFixture({ state: 'applied', managed: true, expiresAt: null }).client.reserved(
				SERVER,
				STEAM
			)
		).toEqual({ state: 'active', expiresAt: null });
	});

	test.each([
		{ state: 'local', managed: false, expiresAt: null },
		{ state: 'failed', managed: true, expiresAt: null },
		{ state: 'applied', managed: true },
		{ state: 'applied', managed: true, expiresAt: 'yesterday' },
		{ state: 'applied', managed: true, expiresAt: '2020-01-01T00:00:00.000Z' }
	])('does not invent expiry or effective reservation from %j', async (slot) => {
		expect(await listFixture(slot).client.reserved(SERVER, STEAM)).toEqual({
			state: 'unknown',
			expiresAt: null
		});
	});

	test.each([
		null,
		{},
		{ syncedAt: null, lastError: '' },
		{ syncedAt: '2020-01-01T00:00:00.000Z', lastError: '' },
		{ syncedAt: new Date().toISOString(), lastError: 'unreachable' }
	])('does not claim an absent slot when sync is unknown or stale: %j', async (sync) => {
		expect(await listFixture(undefined, sync).client.reserved(SERVER, STEAM)).toEqual({
			state: 'unknown',
			expiresAt: null
		});
	});

	test('an unavailable list is unknown rather than a missing entitlement', async () => {
		const { client } = fixture(() => json({ ok: false, error: { code: 'forbidden' } }, 403));
		expect(await client.reserved(SERVER, STEAM)).toEqual({ state: 'unknown', expiresAt: null });
	});
});
