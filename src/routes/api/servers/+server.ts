import { getEnv } from '$lib/server/env';
import { apiJson, readJson, route, str } from '$lib/server/http';
import { accessibleServers, requireOrgRole, requireUser } from '$lib/server/access';
import { createServer } from '$lib/server/servers';
import { serverWorkspaceId } from '$lib/server/workspace';

export const GET = route(async ({ locals }) => {
	const env = getEnv();
	const user = requireUser(locals);
	return apiJson({ ok: true, servers: await accessibleServers(env, user) });
});

/** Adds a server to an org the caller owns. */
export const POST = route(async ({ locals, request }) => {
	const env = getEnv();
	const body = await readJson(request);
	const orgId = serverWorkspaceId(env, str(body.orgId, 64));
	const { org, user } = await requireOrgRole(env, locals, orgId, 'owner');
	const id = await createServer(env, request, user, org, body);
	return apiJson({ ok: true, id }, 201);
});
