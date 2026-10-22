import { describe, expect, test } from 'bun:test';
import type { ManagedServer } from './admin-contracts';
import { DirectWardogsClient } from './wardogs';

const STEAM = '76561198000000001';
const SERVER: ManagedServer = {
	id: 'game-1',
	name: '测试服',
	mode: 'wardogs',
	scheme: 'http',
	host: '127.0.0.1',
	port: 8080,
	password: 'test-rcon-password',
	warconUrl: '',
	warconToken: ''
};
const PLAYER = { steamId: STEAM, name: '玩家', faction: 'BLU', kills: 8, deaths: 3, pingMs: 42 };
const STATUS = {
	serverName: '测试服',
	map: 'Bakurani',
	players: { current: 1, max: 100 },
	factionScores: [
		{ name: 'BLU', colorHex: '#0000ff', score: 20 },
		{ name: 'GRN', colorHex: '#00ff00', score: 30 }
	]
};
type Call = { path: string; init: RequestInit; url: string };
function fixture(responder?: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const client = new DirectWardogsClient(SERVER, {
		fetch: async (input, init = {}) => {
			const url = String(input);
			const call = { url, path: new URL(url).pathname, init };
			calls.push(call);
			if (responder) return responder(call);
			return Response.json(defaultBody(call.path));
		}
	});
	return { client, calls };
}
function defaultBody(path: string) {
	switch (path) {
		case '/v1/status':
			return STATUS;
		case '/v1/players':
			return { players: [PLAYER] };
		case '/v1/capabilities':
			return { routes: ['PATCH /v1/players/{steamId}', 'POST /v1/players/{steamId}/kill'] };
		case '/v1/reserved-slots':
			return { reservedSlots: [] };
		default:
			return { message: 'Completed.' };
	}
}

describe('direct WARDOGS snapshot', () => {
	test('normalizes actual raw RCON shapes and reads a fresh snapshot every time', async () => {
		const { client, calls } = fixture();
		const before = Date.now();
		const snapshot = await client.snapshot(SERVER.id);
		expect(snapshot).toEqual({
			map: 'Bakurani',
			playerCount: 1,
			maxPlayers: 100,
			scores: [
				{ name: 'BLU', score: 20 },
				{ name: 'GRN', score: 30 }
			],
			players: [{ steamId: STEAM, name: '玩家', faction: 'BLU', kills: 8, deaths: 3, ping: 42 }],
			observedAt: expect.any(Number),
			canMove: true
		});
		expect(snapshot.observedAt).toBeGreaterThanOrEqual(before);
		expect(snapshot.observedAt).toBeLessThanOrEqual(Date.now());
		expect(calls.map((call) => call.path)).toEqual([
			'/v1/status',
			'/v1/players',
			'/v1/capabilities'
		]);
		for (const call of calls) {
			expect(call.init.method).toBe('GET');
			expect(call.init.redirect).toBe('error');
			expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer test-rcon-password');
			expect(call.url.startsWith('http://127.0.0.1:8080/')).toBe(true);
		}
		await client.snapshot(SERVER.id);
		expect(calls.length).toBe(6);
	});
	test.each([
		'PATCH /v1/players/{id}',
		'PATCH /v1/players/:id',
		'PATCH /v1/players/*',
		'  PATCH   /v1/players/{steamId}  '
	])('normalizes capability route %s', async (route) => {
		const { client } = fixture(({ path }) =>
			Response.json(path === '/v1/capabilities' ? { routes: [route] } : defaultBody(path))
		);
		expect((await client.snapshot(SERVER.id)).canMove).toBe(true);
	});
	test('a valid capabilities list without PATCH means no move support', async () => {
		const { client } = fixture(({ path }) =>
			Response.json(
				path === '/v1/capabilities' ? { routes: ['GET /v1/players'] } : defaultBody(path)
			)
		);
		expect((await client.snapshot(SERVER.id)).canMove).toBe(false);
	});
	test('supports legacy ping and unavailable faction/ping without inventing statistics', async () => {
		const { client } = fixture(({ path }) =>
			Response.json(
				path === '/v1/players'
					? { players: [{ ...PLAYER, faction: undefined, pingMs: undefined, ping: 20 }] }
					: defaultBody(path)
			)
		);
		expect((await client.snapshot(SERVER.id)).players[0]).toMatchObject({
			faction: null,
			ping: 20
		});
	});
	test.each([
		['/v1/status', { ...STATUS, players: { current: '1', max: 100 } }],
		['/v1/status', { ...STATUS, factionScores: [{ name: 'BLU', score: '20' }] }],
		[
			'/v1/status',
			{ ...STATUS, factionScores: [STATUS.factionScores[0], STATUS.factionScores[0]] }
		],
		['/v1/players', { players: [{ ...PLAYER, steamId: Number(STEAM) }] }],
		['/v1/players', { players: [PLAYER, PLAYER] }],
		['/v1/players', { players: [{ ...PLAYER, deaths: undefined }] }],
		['/v1/players', { players: [{ ...PLAYER, kills: -1 }] }],
		['/v1/players', { players: [{ ...PLAYER, pingMs: '42' }] }],
		['/v1/capabilities', { routes: [123] }],
		['/v1/capabilities', {}]
	])('rejects incomplete %s response', async (badPath, body) => {
		const { client } = fixture(({ path }) =>
			Response.json(path === badPath ? body : defaultBody(path))
		);
		await expect(client.snapshot(SERVER.id)).rejects.toMatchObject({ effect: 'unknown' });
	});
});

describe('direct WARDOGS mutation boundaries', () => {
	test('private message and move use only the expected paths and payloads', async () => {
		const { client, calls } = fixture();
		await client.whisper(SERVER.id, STEAM, '验证码 123456');
		await client.move(SERVER.id, STEAM, 'GRN');
		expect(calls.map(({ path, init }) => `${init.method} ${path}`)).toEqual([
			`POST /v1/players/${STEAM}/message`,
			`PATCH /v1/players/${STEAM}`,
			`POST /v1/players/${STEAM}/kill`
		]);
		expect(JSON.parse(String(calls[0].init.body))).toEqual({ message: '验证码 123456' });
		expect(JSON.parse(String(calls[1].init.body))).toEqual({ faction: 'GRN' });
		expect(calls[2].init.body).toBeUndefined();
	});
	test.each([
		[401, 'unauthorized'],
		[403, 'forbidden'],
		[404, 'player_not_found'],
		[404, 'not_found'],
		[400, 'invalid_faction'],
		[429, 'rate_limited']
	])(
		'a recognized PATCH refusal %s %s is refundable and never followed by a kill',
		async (status, code) => {
			const { client, calls } = fixture(() =>
				Response.json({ error: { code, message: 'refused' } }, { status })
			);
			await expect(client.move(SERVER.id, STEAM, 'GRN')).rejects.toMatchObject({
				effect: 'refused'
			});
			expect(calls).toHaveLength(1);
		}
	);
	test.each([
		[500, 'internal'],
		[503, 'unavailable'],
		[400, 'error'],
		[409, 'conflict'],
		[401, 'something_else']
	])(
		'unrecognized or server PATCH errors %s %s stay uncertain without retry or kill',
		async (status, code) => {
			const { client, calls } = fixture(() => Response.json({ error: { code } }, { status }));
			await expect(client.move(SERVER.id, STEAM, 'GRN')).rejects.toMatchObject({
				effect: 'unknown'
			});
			expect(calls).toHaveLength(1);
		}
	);
	test.each([
		{},
		{ message: '' },
		{ message: '   ' },
		{ message: 1 },
		{ ok: false, message: 'No.' },
		{ ok: 'false', message: 'No.' },
		{ ok: true, message: 'OK', error: { code: 'error' } }
	])('malformed PATCH success %j does not trigger kill or report success', async (body) => {
		const { client, calls } = fixture(() => Response.json(body));
		await expect(client.move(SERVER.id, STEAM, 'GRN')).rejects.toMatchObject({ effect: 'unknown' });
		expect(calls).toHaveLength(1);
	});
	test.each([404, 429, 500])(
		'once moved, kill HTTP %i cannot refund or repeat the move',
		async (status) => {
			const { client, calls } = fixture(({ init }) =>
				init.method === 'PATCH'
					? Response.json({ message: 'Moved to GRN.' })
					: Response.json(
							{ ok: false, error: { code: status === 404 ? 'player_not_found' : 'rate_limited' } },
							{ status }
						)
			);
			await client.move(SERVER.id, STEAM, 'GRN');
			expect(calls).toHaveLength(2);
		}
	);
	test('once moved, malformed or disconnected respawn responses cannot refund', async () => {
		for (const fail of [
			() => new Response('<html>bad</html>'),
			() => {
				throw new Error('disconnected');
			}
		]) {
			const { client, calls } = fixture(({ init }) =>
				init.method === 'PATCH' ? Response.json({ message: 'Moved.' }) : fail()
			);
			await client.move(SERVER.id, STEAM, 'GRN');
			expect(calls).toHaveLength(2);
		}
	});
	test('PATCH timeout cancels the request and remains uncertain; kill timeout preserves success', async () => {
		for (const timeoutAt of ['PATCH', 'POST']) {
			const signals: AbortSignal[] = [];
			const methods: string[] = [];
			const client = new DirectWardogsClient(SERVER, {
				timeoutMs: 10,
				fetch: async (_, init) => {
					methods.push(init!.method!);
					signals.push(init!.signal!);
					if (init!.method === timeoutAt) return new Promise(() => {});
					return Response.json({ message: 'Moved.' });
				}
			});
			if (timeoutAt === 'PATCH')
				await expect(client.move(SERVER.id, STEAM, 'GRN')).rejects.toMatchObject({
					effect: 'unknown'
				});
			else await client.move(SERVER.id, STEAM, 'GRN');
			expect(methods).toEqual(timeoutAt === 'PATCH' ? ['PATCH'] : ['PATCH', 'POST']);
			expect(signals.at(-1)!.aborted).toBe(true);
		}
	});
	test('whisper must have a meaningful success message and never exposes echoed codes', async () => {
		const { client, calls } = fixture(() =>
			Response.json(
				{ ok: false, error: { code: 'error', message: '123456 private-password' } },
				{ status: 500 }
			)
		);
		try {
			await client.whisper(SERVER.id, STEAM, '123456');
			throw new Error('expected failure');
		} catch (error) {
			expect(String(error)).not.toContain('123456');
			expect(String(error)).not.toContain('private-password');
		}
		expect(calls).toHaveLength(1);
		await expect(
			fixture(() => Response.json({})).client.whisper(SERVER.id, STEAM, '123456')
		).rejects.toMatchObject({ effect: 'unknown' });
	});
	test('rejects malformed JSON, HTML, redirects and oversized responses without retries', async () => {
		for (const response of [
			new Response('<html>Proxy</html>', { headers: { 'content-type': 'text/html' } }),
			new Response('{', { headers: { 'content-type': 'application/json' } }),
			new Response('', { status: 302, headers: { location: 'http://evil.test/' } }),
			Response.json({ padding: 'x'.repeat(1024 * 1024) })
		]) {
			const { client, calls } = fixture(() => response);
			await expect(client.move(SERVER.id, STEAM, 'GRN')).rejects.toMatchObject({
				effect: 'unknown'
			});
			expect(calls).toHaveLength(1);
			expect(calls[0].init.redirect).toBe('error');
		}
	});
});

describe('direct server isolation and reserved slots', () => {
	test('rejects a mismatched server for every operation without sending a request', async () => {
		const { client, calls } = fixture();
		for (const operation of [
			() => client.snapshot('other'),
			() => client.whisper('other', STEAM, 'hi'),
			() => client.move('other', STEAM, 'GRN'),
			() => client.reserved('other', STEAM)
		])
			await expect(operation()).rejects.toMatchObject({ effect: 'refused' });
		expect(calls).toHaveLength(0);
	});
	test('refuses malformed Steam ID, faction and whisper before sending', async () => {
		const { client, calls } = fixture();
		await expect(client.move(SERVER.id, '../../other', 'GRN')).rejects.toMatchObject({
			effect: 'refused'
		});
		await expect(client.move(SERVER.id, STEAM, ' GRN')).rejects.toMatchObject({
			effect: 'refused'
		});
		await expect(client.whisper(SERVER.id, STEAM, 'x'.repeat(257))).rejects.toMatchObject({
			effect: 'refused'
		});
		expect(calls).toHaveLength(0);
	});
	test.each([
		'evil.test/path',
		'user@evil.test',
		'evil.test?x=y',
		'evil.test#x',
		'http://evil.test',
		'evil.test:1234',
		' evil.test'
	])('refuses an authority masquerading as host %s', (host) => {
		expect(() => new DirectWardogsClient({ ...SERVER, host })).toThrow();
	});
	test.each(['::1', '[::1]'])(
		'supports IPv6 host %s without embedding credentials in URL',
		async (host) => {
			let target = '';
			const client = new DirectWardogsClient(
				{ ...SERVER, host, scheme: 'https' },
				{
					fetch: async (input) => {
						target = String(input);
						return Response.json({ message: 'Sent.' });
					}
				}
			);
			await client.whisper(SERVER.id, STEAM, 'test');
			expect(target).toBe(`https://[::1]:8080/v1/players/${STEAM}/message`);
		}
	);
	test('native reserved list cannot establish expiry or effective permanent entitlement', async () => {
		const present = fixture(() => Response.json({ reservedSlots: [STEAM] }));
		expect(await present.client.reserved(SERVER.id, STEAM)).toEqual({
			state: 'unknown',
			expiresAt: null
		});
		expect(present.calls[0].path).toBe('/v1/reserved-slots');
		expect(await fixture().client.reserved(SERVER.id, STEAM)).toEqual({
			state: 'none',
			expiresAt: null
		});
	});
	test.each([
		{},
		{ reservedSlots: 'none' },
		{ reservedSlots: [Number(STEAM)] },
		{ reservedSlots: [{ steamId: STEAM }] }
	])('invalid reserved shape %j is unknown', async (body) => {
		expect(await fixture(() => Response.json(body)).client.reserved(SERVER.id, STEAM)).toEqual({
			state: 'unknown',
			expiresAt: null
		});
	});
	test('unsupported or unreachable reserved API is unknown, never an empty entitlement', async () => {
		expect(
			await fixture(() =>
				Response.json({ error: { code: 'not_found' } }, { status: 404 })
			).client.reserved(SERVER.id, STEAM)
		).toEqual({ state: 'unknown', expiresAt: null });
	});
});
