import { describe, expect, test } from 'bun:test';
import type { Db } from './db';
import type { Env } from './env';
import type { OrgRow, SessionUser } from './access';
import { ApiError } from './http';
import { createOrg, deleteOrg, updateOrg } from './orgs';
import { assertMayCreateOrg, orgSignupEnabled, orgsRemaining } from './signup';
import {
	assertWorkspaceMutable,
	getWorkspace,
	resolveWorkspaceId,
	serverWorkspaceId
} from './workspace';

// Selection outcomes without a database. SQL scoping is covered against Postgres separately.
function rowsDb(ids: string[]): Db {
	const query = {
		where: () => query,
		limit: async (n: number) => ids.slice(0, n).map((id) => ({ id }))
	};
	return { select: () => ({ from: () => query }) } as unknown as Db;
}

const fixed = { WARCON_WORKSPACE_ID: 'space' };
const site = { id: 'site', role: 'owner' } as SessionUser;
const env = { ...fixed, ALLOW_ORG_SIGNUP: 'true' } as Env;
const request = new Request('http://localhost/test');

describe('fixed management space', () => {
	test('startup selects a sole migrated organisation, including an empty fresh install', async () => {
		expect(await resolveWorkspaceId(rowsDb(['default']))).toBe('default');
		expect(await resolveWorkspaceId(rowsDb(['default']), '  ')).toBe('default');
	});

	test('startup refuses ambiguous or missing data instead of guessing or creating it', async () => {
		await expect(resolveWorkspaceId(rowsDb(['first', 'second']))).rejects.toThrow(
			'Multiple organisations'
		);
		await expect(resolveWorkspaceId(rowsDb([]))).rejects.toThrow('No management space exists');
	});

	test('configured selection must exist, and failures never echo configuration input', async () => {
		expect(await resolveWorkspaceId(rowsDb(['selected']), ' selected ')).toBe('selected');
		const secretInput = 'accidental-secret-in-config';
		try {
			await resolveWorkspaceId(rowsDb([]), secretInput);
			throw new Error('should reject');
		} catch (error) {
			expect((error as Error).message).toContain('does not identify');
			expect((error as Error).message).not.toContain(secretInput);
		}
	});

	test('new servers default to the workspace and reject a different destination', () => {
		expect(serverWorkspaceId(fixed, '')).toBe('space');
		expect(serverWorkspaceId(fixed, 'space')).toBe('space');
		expect(() => serverWorkspaceId(fixed, 'other')).toThrow(ApiError);
	});

	test('compatibility fixtures retain explicit destinations and require one', async () => {
		expect(serverWorkspaceId({}, 'other')).toBe('other');
		expect(() => serverWorkspaceId({}, '')).toThrow('orgId');
		expect(() => assertWorkspaceMutable({})).not.toThrow();
		expect(await getWorkspace({} as Env)).toBeNull();
	});

	test('site owners cannot create organisations even with the old signup flag enabled', async () => {
		expect(orgSignupEnabled(env)).toBe(false);
		expect(orgSignupEnabled({ ALLOW_ORG_SIGNUP: 'true' })).toBe(true);
		expect(await orgsRemaining(env, site)).toBe(0);
		await expect(assertMayCreateOrg(env, site)).rejects.toMatchObject({
			status: 403,
			code: 'workspace_fixed'
		});
	});

	test('service guards stop create/delete/rename before any database write or audit', async () => {
		const org = { id: 'space' } as OrgRow;
		for (const call of [
			() => createOrg(env, request, site, { name: 'New space' }),
			() => deleteOrg(env, request, site, org),
			() => updateOrg(env, request, site, org, { name: 'Changed' }),
			() => updateOrg(env, request, site, org, { name: null, boardOpens: 'all' })
		]) {
			await expect(call()).rejects.toMatchObject({ status: 403, code: 'workspace_fixed' });
		}
	});
});
