import { beforeAll, describe, expect, test } from 'bun:test';
import type { Env } from '$lib/server/env';
import { kills, matches, matchEvents, samples } from '$lib/server/db/schema';
import { loadMatch, MATCH_EVENT_LIMIT, MATCH_SCORE_LIMIT } from '$lib/server/matches';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';
import { GET } from '../routes/api/servers/[id]/matches/[matchId]/+server';
import type { MatchView } from '$lib/matches';

describe.skipIf(!hasTestDb)('match evidence scope and provenance', () => {
	let env: Env;
	let world: World;
	const start = new Date('2026-10-20T10:00:00Z');
	const end = new Date('2026-10-20T11:00:00Z');
	const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		world = await seedWorld(env);
	});
	const fresh = async () => {
		const [match] = await env.db
			.insert(matches)
			.values({ serverId: world.server.id, startedAt: start, endedAt: end, map: 'Kavkazi' })
			.returning();
		return match;
	};
	const kill = (matchRow: number, matchId: string, instanceId = 'boot-1') => ({
		ts: at(100),
		serverId: world.server.id,
		eventId: `kill-${matchRow}-${instanceId}-${matchId}`,
		matchRow,
		matchId,
		instanceId,
		eventTime: 100,
		map: 'Kavkazi',
		victimSteamId: '76561198000000099',
		victimName: 'Victim',
		cause: '',
		tags: []
	});
	const event = (eventId: string, matchId: string) => ({
		ts: at(200),
		serverId: world.server.id,
		eventId,
		seq: 0,
		instanceId: 'boot-1',
		matchId,
		eventTime: 199.5,
		map: 'Kavkazi',
		type: 'match_state',
		state: 'MatchState.InMatch'
	});

	test('requires exact game match, server instance, server, map and half-open receipt window', async () => {
		const m = await fresh();
		const gameId = `game-${m.id}`;
		await env.db.insert(kills).values(kill(m.id, gameId));
		await env.db.insert(matchEvents).values([
			{ ...event(`start-${m.id}`, gameId), ts: start },
			{
				...event(`end-${m.id}`, gameId),
				ts: at(3599),
				seq: 1,
				type: 'match_ended',
				state: null,
				players: 24,
				winningFaction: 'Valkyra',
				scores: [{ name: 'Valkyra', score: 100 }]
			},
			{ ...event(`old-${m.id}`, gameId), ts: at(-1) },
			{ ...event(`boundary-${m.id}`, gameId), ts: end },
			{ ...event(`late-${m.id}`, gameId), ts: at(3601) },
			event(`adjacent-${m.id}`, `other-${gameId}`),
			{ ...event(`boot-${m.id}`, gameId), instanceId: 'boot-2' },
			{ ...event(`server-${m.id}`, gameId), serverId: world.otherServer.id },
			{ ...event(`map-${m.id}`, gameId), map: 'Europe' },
			{ ...event(`empty-${m.id}`, gameId), matchId: null }
		]);
		const response = await callApi(GET, world.users.viewer, {
			params: { id: world.server.id, matchId: String(m.id) }
		});
		expect(response.status).toBe(200);
		const view = response.body as MatchView;
		expect(view.history.feed.link).toBe('linked_kills');
		expect(view.history.feed.events.map((e) => e.eventId)).toEqual([
			`start-${m.id}`,
			`end-${m.id}`
		]);
		expect(view.history.feed.events[1]).toEqual({
			source: 'game_feed',
			eventId: `end-${m.id}`,
			receivedAt: at(3599).toISOString(),
			eventTime: 199.5,
			instanceId: 'boot-1',
			matchId: gameId,
			type: 'match_ended',
			map: 'Kavkazi',
			state: null,
			players: 24,
			winningFaction: 'Valkyra',
			scores: [{ name: 'Valkyra', score: 100 }]
		});
		expect(await loadMatch(env, world.otherServer.id, m.id)).toBeNull();
	});

	test('withholds guessed history without a unique kill identity', async () => {
		const missing = await fresh();
		expect((await loadMatch(env, world.server.id, missing.id))?.history.feed).toEqual({
			link: 'unavailable',
			events: [],
			truncated: false
		});
		const ambiguous = await fresh();
		await env.db
			.insert(kills)
			.values([kill(ambiguous.id, 'same', 'boot-1'), kill(ambiguous.id, 'same', 'boot-2')]);
		await env.db.insert(matchEvents).values(event(`ambiguous-${ambiguous.id}`, 'same'));
		expect((await loadMatch(env, world.server.id, ambiguous.id))?.history.feed).toEqual({
			link: 'ambiguous',
			events: [],
			truncated: false
		});
	});

	test('score evidence is bounded, omits adjacent windows and other maps, reports source and gaps', async () => {
		const w = await seedWorld(env);
		const [m] = await env.db
			.insert(matches)
			.values({ serverId: w.server.id, startedAt: start, endedAt: end, map: 'Kavkazi' })
			.returning();
		const sample = (seconds: number, score: number) => ({
			ts: at(seconds),
			serverId: w.server.id,
			ok: true,
			map: 'Kavkazi',
			scores: [{ name: 'Valkyra', score }]
		});
		await env.db
			.insert(samples)
			.values([
				sample(-1, 90),
				sample(0, 19),
				sample(10, 20),
				sample(60, 41),
				sample(3600, 0),
				{ ...sample(20, 100), map: 'Europe' },
				{ ...sample(25, 100), serverId: w.otherServer.id },
				{ ...sample(30, 100), ok: false }
			]);
		const view = (await loadMatch(env, w.server.id, m.id))!;
		expect(view.timeline).toEqual([
			[0, 19],
			[10, 20],
			[60, 41]
		]);
		expect(view.history.scores.samples).toBe(3);
		expect(view.history.scores.maxGapSeconds).toBe(50);
		expect(
			view.history.scores.milestones.map((p) => [p.threshold, p.firstObservedAt, p.previousBelowAt])
		).toEqual([
			[20, at(10).toISOString(), start.toISOString()],
			[40, at(60).toISOString(), at(10).toISOString()]
		]);
	});

	test('large histories stop at explicit response limits', async () => {
		const w = await seedWorld(env);
		const [m] = await env.db
			.insert(matches)
			.values({ serverId: w.server.id, startedAt: start, endedAt: end, map: 'Kavkazi' })
			.returning();
		await env.db.insert(kills).values({ ...kill(m.id, `limit-${m.id}`), serverId: w.server.id });
		await env.db.insert(matchEvents).values(
			Array.from({ length: MATCH_EVENT_LIMIT + 1 }, (_, seq) => ({
				...event(`limit-${m.id}-${seq}`, `limit-${m.id}`),
				serverId: w.server.id,
				seq
			}))
		);
		// A batch remains below PostgreSQL's parameter limit.
		for (let offset = 0; offset <= MATCH_SCORE_LIMIT; offset += 1000)
			await env.db.insert(samples).values(
				Array.from({ length: Math.min(1000, MATCH_SCORE_LIMIT + 1 - offset) }, (_, i) => ({
					ts: new Date(start.getTime() + offset + i),
					serverId: w.server.id,
					ok: true,
					map: 'Kavkazi',
					scores: [{ name: 'Valkyra', score: 10 }]
				}))
			);
		const view = (await loadMatch(env, w.server.id, m.id))!;
		expect(view.timeline).toHaveLength(MATCH_SCORE_LIMIT);
		expect(view.history.scores.truncated).toBe(true);
		expect(view.history.feed.events).toHaveLength(MATCH_EVENT_LIMIT);
		expect(view.history.feed.truncated).toBe(true);
	});
});
