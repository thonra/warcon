import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, samples, servers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { WardogsClient } from '$lib/server/rcon';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

describe.skipIf(!hasTestDb)('score-only observation persistence', () => {
	let env: Env;
	let spy: ReturnType<typeof spyOn>;
	let serverId = '';
	let scores = [
		{ name: 'Valkyra', score: 19, colorHex: '#ff0000' },
		{ name: 'Lonestar', score: 10, colorHex: '#0000ff' }
	];
	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		expect(await acquireOrRenew(env, 'score-samples')).toBe(true);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`scores-${server.id}`
			);
			const raw = client.raw.bind(client);
			client.raw = async (method, path, body, headers) => {
				if (method !== 'GET' || path !== '/v1/status') return raw(method, path, body, headers);
				return {
					status: 200,
					statusText: 'OK',
					headers: { 'content-type': 'application/json' },
					text: JSON.stringify({
						serverName: 'Scores',
						map: 'Kavkazi',
						experiences: [],
						players: { current: 2, max: 100 },
						factionScores: scores,
						rotation: { nowIndex: 0, nextIndex: 1 }
					})
				};
			};
			return client;
		});
	});
	afterAll(async () => {
		spy?.mockRestore();
		forgetMemory(serverId);
		await releaseOwnership(env);
	});

	test('keeps a threshold crossing before heartbeat, ignores reordered scores and colour changes', async () => {
		const w = await seedWorld(env);
		serverId = w.server.id;
		const [server] = await env.db.select().from(servers).where(eq(servers.id, serverId));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		const look = async () => {
			// Keep the heartbeat firmly in the future: only a changed sample key may persist.
			m.sampleWrittenAt = Date.now() + 60_000;
			await observeServer(env, m, { status: true, players: false });
		};
		const kept = () =>
			env.db.select().from(samples).where(eq(samples.serverId, serverId)).orderBy(samples.ts);
		await look();
		expect(await kept()).toHaveLength(1);
		scores = scores.map((f) => (f.name === 'Valkyra' ? { ...f, score: 20 } : f));
		await look();
		expect((await kept()).map((r) => r.scores)).toEqual([
			[
				{ name: 'Valkyra', score: 19 },
				{ name: 'Lonestar', score: 10 }
			],
			[
				{ name: 'Valkyra', score: 20 },
				{ name: 'Lonestar', score: 10 }
			]
		]);
		scores = scores.toReversed().map((f) => ({ ...f, colorHex: '#123456' }));
		await look();
		expect(await kept()).toHaveLength(2);
	});
});
