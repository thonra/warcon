import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, servers } from '$lib/server/db/schema';
import { getWorkspace, resolveWorkspaceId } from '$lib/server/workspace';
import { createInvite, findInvite, isMember, joinOrg } from '$lib/server/orgs';
import { requireListsRole, requireOrgRole, serverAccessFor } from '$lib/server/access';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');

describe.skipIf(!hasTestDb)('single workspace compatibility', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
	});

	async function fixed<T>(run: () => Promise<T>): Promise<T> {
		const previous = env.WARCON_WORKSPACE_ID;
		env.WARCON_WORKSPACE_ID = w.org.id;
		try {
			return await run();
		} finally {
			if (previous === undefined) delete env.WARCON_WORKSPACE_ID;
			else env.WARCON_WORKSPACE_ID = previous;
		}
	}

	async function call(
		who: PrincipalName,
		method: string,
		path: string,
		body: object = {},
		id = w.org.id
	) {
		const module = await import(join(ROUTES, path, '+server.ts'));
		return callApi(module[method], w.users[who], { method, params: { id }, body });
	}

	test('an explicit id is selected from several organisations without changing any rows', async () => {
		const before = await env.db.select().from(organizations);
		expect(await resolveWorkspaceId(env.db, w.org.id)).toBe(w.org.id);
		expect(await resolveWorkspaceId(env.db, w.otherOrg.id)).toBe(w.otherOrg.id);
		await expect(resolveWorkspaceId(env.db)).rejects.toThrow('Multiple organisations');
		await expect(resolveWorkspaceId(env.db, 'missing-workspace')).rejects.toThrow(
			'does not identify'
		);
		expect(await env.db.select().from(organizations)).toEqual(before);
		await fixed(async () => expect((await getWorkspace(env))?.id).toBe(w.org.id));
	});

	test("the app layout ignores stale scope cookies/defaults while retaining each user's grants", () =>
		fixed(async () => {
			const { load } = await import('../routes/(app)/+layout.server');
			for (const who of ['site', 'viewer', 'member', 'stranger', 'outsider'] as const) {
				const user = { ...w.users[who]!, defaultOrgId: w.otherOrg.id };
				const data = (await load({
					locals: { user },
					cookies: { get: (key: string) => (key === 'warcon_scope' ? w.otherOrg.id : undefined) }
				} as never)) as {
					orgs: { id: string }[];
					scope: { id: string };
					servers: { id: string; orgId: string; manager: boolean }[];
					canManage: boolean;
					canCreateOrg?: unknown;
				};
				expect(data.scope.id).toBe(w.org.id);
				expect(data.orgs.every((org) => org.id === w.org.id)).toBe(true);
				expect(data.servers.every((server) => server.orgId === w.org.id)).toBe(true);
				expect(data).not.toHaveProperty('canCreateOrg');
				if (who === 'site') {
					expect(data.orgs.map((org) => org.id)).toEqual([w.org.id]);
					expect(data.servers.map((server) => server.id).sort()).toEqual(
						[w.server.id, w.otherServer.id].sort()
					);
				} else {
					expect(data.canManage).toBe(false);
					if (who === 'viewer') {
						expect(data.servers.map((server) => server.id)).toEqual([w.server.id]);
						expect(data.servers[0].manager).toBe(false);
					} else expect(data.servers).toEqual([]);
				}
			}
		}));

	test('the site owner cannot create, delete or rename either stored organisation', () =>
		fixed(async () => {
			const before = await env.db.select().from(organizations);
			for (const who of ['site', 'owner'] as const) {
				expect((await call(who, 'POST', 'orgs', { name: 'Should not exist' })).code).toBe(
					'workspace_fixed'
				);
				expect((await call(who, 'DELETE', 'orgs/[id]')).code).toBe('workspace_fixed');
				expect((await call(who, 'PATCH', 'orgs/[id]', { name: 'Changed' })).code).toBe(
					'workspace_fixed'
				);
			}
			expect((await call('site', 'DELETE', 'orgs/[id]', {}, w.otherOrg.id)).status).toBe(404);
			expect(await env.db.select().from(organizations)).toEqual(before);
		}));

	test('direct page guards and child APIs reject another stored space even for the site owner', () =>
		fixed(async () => {
			for (const who of ['site', 'outsider'] as const) {
				const locals = { user: w.users[who] } as App.Locals;
				await expect(requireOrgRole(env, locals, w.otherOrg.id, 'owner')).rejects.toMatchObject({
					status: 404
				});
				await expect(requireListsRole(env, locals, w.otherOrg.id, 'any')).rejects.toMatchObject({
					status: 404
				});
				for (const path of [
					'orgs/[id]/keys',
					'orgs/[id]/roles',
					'orgs/[id]/lists',
					'orgs/[id]/invites'
				]) {
					expect((await call(who, 'GET', path, {}, w.otherOrg.id)).status).toBe(404);
				}
			}
			const result = await call('site', 'GET', 'orgs');
			expect((result.body as { orgs: { id: string }[] }).orgs.map((org) => org.id)).toEqual([
				w.org.id
			]);
			expect((await call('outsider', 'GET', 'orgs')).body).toEqual({ ok: true, orgs: [] });
			expect(
				(
					await call(
						'site',
						'POST',
						'orgs/[id]/broadcast',
						{ message: 'must not send', serverIds: null },
						w.otherOrg.id
					)
				).status
			).toBe(404);
		}));

	test('suspension is closed without affecting public policy settings', () =>
		fixed(async () => {
			for (const suspended of [true, false]) {
				expect(
					(await call('site', 'PATCH', 'orgs/[id]', { suspended, allowPublicStatus: false })).code
				).toBe('workspace_fixed');
			}
			const [row] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
			expect(row.suspendedAt).toBeNull();
		}));

	test('mixed rename bodies refuse every PATCH branch without applying another setting', () =>
		fixed(async () => {
			const [before] = await env.db
				.select()
				.from(organizations)
				.where(eq(organizations.id, w.org.id));
			for (const change of [
				{ serverLimit: 22 },
				{ suspended: true },
				{ allowPublicStatus: false },
				{ allowPublicLeaderboards: false },
				{ membersReserved: true },
				{ banMessage: 'changed' },
				{ banReasons: [] },
				{ savedMessages: [] },
				{ boardOpens: 'all' }
			]) {
				const result = await call('site', 'PATCH', 'orgs/[id]', { ...change, name: null });
				expect(result.code).toBe('workspace_fixed');
			}
			const [after] = await env.db
				.select()
				.from(organizations)
				.where(eq(organizations.id, w.org.id));
			expect(after).toEqual(before);
		}));

	test('workspace settings still require their existing roles and save normally', () =>
		fixed(async () => {
			expect((await call('owner', 'PATCH', 'orgs/[id]', { boardOpens: 'all' })).status).toBe(200);
			expect((await call('member', 'PATCH', 'orgs/[id]', { boardOpens: 'official' })).status).toBe(
				403
			);
			expect((await call('owner', 'PATCH', 'orgs/[id]', { allowPublicStatus: false })).status).toBe(
				403
			);
			expect((await call('site', 'PATCH', 'orgs/[id]', { allowPublicStatus: false })).status).toBe(
				200
			);
			const [row] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
			expect(row.boardOpens).toBe('all');
			expect(row.allowPublicStatus).toBe(false);
		}));

	test('scope changes are closed including clear/all/same-id, without bypassing authentication', () =>
		fixed(async () => {
			for (const body of [{ orgId: null }, { orgId: w.org.id }, { orgId: w.otherOrg.id }]) {
				expect((await call('site', 'PUT', 'scope', body)).code).toBe('workspace_fixed');
			}
			expect((await call('owner', 'DELETE', 'scope')).code).toBe('workspace_fixed');
			expect((await call('anon', 'PUT', 'scope')).status).toBe(401);
			expect((await call('anon', 'DELETE', 'scope')).status).toBe(401);
		}));

	test('new servers use the fixed id, while non-managers and other destinations remain refused', () =>
		fixed(async () => {
			const body = {
				name: 'Workspace demo',
				host: 'demo',
				port: 7779,
				scheme: 'http',
				password: 'demo'
			};
			for (const who of ['viewer', 'member', 'outsider'] as const) {
				expect([403, 404]).toContain((await call(who, 'POST', 'servers', body)).status);
			}
			expect((await call('site', 'POST', 'servers', { ...body, orgId: w.otherOrg.id })).code).toBe(
				'workspace_fixed'
			);
			const result = await call('owner', 'POST', 'servers', body);
			expect(result.status).toBe(201);
			const id = (result.body as { id: string }).id;
			const [row] = await env.db.select().from(servers).where(eq(servers.id, id));
			expect(row.orgId).toBe(w.org.id);
		}));

	test('invitations still admit a member without expanding unrelated server access', () =>
		fixed(async () => {
			const owner = w.users.owner!;
			const joiner = w.users.stranger!;
			const { org } = await requireOrgRole(env, { user: owner } as App.Locals, w.org.id, 'owner');
			const req = new Request('http://localhost/test', { method: 'POST' });
			const view = await createInvite(env, req, owner, org, {
				label: 'Workspace member',
				maxUses: 1
			});
			const found = await findInvite(env, new URL(view.url).pathname.split('/').at(-1)!);
			expect(found).not.toBeNull();
			await joinOrg(env, req, joiner, found!.invite, org);
			expect(await isMember(env, org.id, joiner.id)).toBe(true);
			expect(await serverAccessFor(env, joiner, w.server.id)).toBeNull();
			expect(await serverAccessFor(env, joiner, w.otherOrgServer.id)).toBeNull();
		}));

	test('an existing invitation to another stored space cannot be looked up or accepted', async () => {
		const owner = w.users.outsider!;
		const { org } = await requireOrgRole(
			env,
			{ user: owner } as App.Locals,
			w.otherOrg.id,
			'owner'
		);
		const req = new Request('http://localhost/test', { method: 'POST' });
		const view = await createInvite(env, req, owner, org, { label: 'Legacy invitation' });
		const token = new URL(view.url).pathname.split('/').at(-1)!;
		const found = (await findInvite(env, token))!;
		await fixed(async () => {
			expect(await findInvite(env, token)).toBeNull();
			await expect(joinOrg(env, req, w.users.member!, found.invite, org)).rejects.toMatchObject({
				status: 404
			});
			expect(await isMember(env, org.id, w.users.member!.id)).toBe(false);
		});
	});
});
