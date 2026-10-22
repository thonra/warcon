// Management navigation must keep the existing permission boundary while selecting one fixed space.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import { userOrgs } from '$lib/server/access';
import { orgsLink } from '$lib/orgs';
import { hasTestDb, testEnv } from './db';
import { callLoad, stubGateway } from './call';
import { seedWorld, suspend, type PrincipalName, type World } from './world';
import { load as manageEntry } from '../routes/(app)/manage/+page.server';
import { load as legacyEntry } from '../routes/(app)/orgs/+page.server';
import { load as legacyPage } from '../routes/(app)/orgs/[...legacy]/+page.server';

const MANAGE = join(import.meta.dir, '..', 'routes', '(app)', 'manage');

/** The management layout and the section the href names, loaded with the real role checks. */
async function opens(world: World, who: PrincipalName, href: string): Promise<(number | 'ok')[]> {
	const [, id, sub = ''] = href.match(/^\/manage\/([^/]+)(\/[a-z]+)?$/)!;
	const answers: (number | 'ok')[] = [];
	for (const file of ['[id]/+layout.server.ts', `[id]${sub}/+page.server.ts`]) {
		const { load } = await import(join(MANAGE, file));
		const res = await callLoad(load, world.users[who], { params: { id: decodeURIComponent(id) } });
		answers.push(res.status === 200 ? 'ok' : res.status);
	}
	return answers;
}

describe.skipIf(!hasTestDb)('the Manage link and fixed management entry point', () => {
	let env: Env;
	let world: World;
	let previousWorkspace: string | undefined;
	const memberships = (w: World, who: PrincipalName) => userOrgs(env, w.users[who]!);
	const linkOf = async (w: World, who: PrincipalName) =>
		orgsLink(
			(await memberships(w, who)).filter((entry) => entry.id === env.WARCON_WORKSPACE_ID),
			w.users[who]!.role === 'owner'
		);
	const landing = async (w: World, who: PrincipalName) => {
		// Use real memberships. The loader also checks the fixed id if a caller passes extra entries.
		const orgs = await memberships(w, who);
		return callLoad(
			(event) => manageEntry(Object.assign({}, event, { parent: async () => ({ orgs }) }) as never),
			w.users[who]
		);
	};

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		world = await seedWorld(env);
	});
	beforeEach(() => {
		previousWorkspace = env.WARCON_WORKSPACE_ID;
		env.WARCON_WORKSPACE_ID = world.org.id;
	});
	afterEach(() => {
		if (previousWorkspace === undefined) delete env.WARCON_WORKSPACE_ID;
		else env.WARCON_WORKSPACE_ID = previousWorkspace;
	});

	test('opens only sections allowed by the fixed space membership and list capabilities', async () => {
		const base = `/manage/${world.org.id}`;
		const want: Partial<Record<PrincipalName, string>> = {
			stranger: '/manage',
			outsider: '/manage',
			member: '/manage',
			viewer: '/manage',
			operator: '/manage',
			admin: `${base}/bans`,
			elsewhere: `${base}/bans`,
			orgBans: `${base}/bans`,
			orgSlots: `${base}/reserved`,
			owner: base,
			site: base
		};
		for (const [who, href] of Object.entries(want) as [PrincipalName, string][]) {
			expect({ who, href: await linkOf(world, who) }).toEqual({ who, href });
			const result = await landing(world, who);
			if (href === '/manage') {
				expect({ who, status: result.status }).toEqual({ who, status: 403 });
				continue;
			}
			expect({ who, status: result.status, href: result.message }).toEqual({
				who,
				status: 302,
				href
			});
			expect({ who, answers: await opens(world, who, href) }).toEqual({
				who,
				answers: ['ok', 'ok']
			});
		}
	});

	test('list editors still cannot load the management overview', async () => {
		for (const who of ['orgBans', 'orgSlots'] as const)
			expect(await opens(world, who, `/manage/${world.org.id}`)).toEqual(['ok', 403]);
	});

	test('the layout rejects another id even for its owner or the site owner', async () => {
		const { load } = await import(join(MANAGE, '[id]/+layout.server.ts'));
		for (const who of ['outsider', 'site'] as const)
			expect(
				(await callLoad(load, world.users[who], { params: { id: world.otherOrg.id } })).status
			).toBe(404);
	});

	test('suspension never grants a member a section through stale list capabilities', async () => {
		const w = await seedWorld(env);
		env.WARCON_WORKSPACE_ID = w.org.id;
		await suspend(env, w.org.id);
		expect(await opens(w, 'owner', `/manage/${w.org.id}`)).toEqual([403, 403]);
		for (const who of ['owner', 'admin', 'orgBans', 'orgSlots', 'outsider'] as const) {
			expect(await linkOf(w, who)).toBe('/manage');
			expect((await landing(w, who)).status).toBe(403);
		}
		expect(await linkOf(w, 'site')).toBe(`/manage/${w.org.id}`);
		expect((await landing(w, 'site')).status).toBe(302);
	});
});

describe('legacy management bookmarks', () => {
	test('redirects the old index and deep links while preserving the query', async () => {
		const index = await callLoad(legacyEntry, null, { query: 'q=test%20name&page=2' });
		expect({ status: index.status, href: index.message }).toEqual({
			status: 308,
			href: '/manage?q=test%20name&page=2'
		});
		const deep = await callLoad(legacyPage, null, {
			params: { legacy: 'space/reserved/group with space' },
			query: 'q=test%20name&page=2'
		});
		expect({ status: deep.status, href: deep.message }).toEqual({
			status: 308,
			href: '/manage/space/reserved/group%20with%20space?q=test%20name&page=2'
		});
	});

	test('never redirects mutation requests', async () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect((await callLoad(legacyEntry, null, { method })).status).toBe(405);
			expect(
				(await callLoad(legacyPage, null, { method, params: { legacy: 'space/bans' } })).status
			).toBe(405);
		}
	});
});
