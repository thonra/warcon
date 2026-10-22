import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { orgHome } from '$lib/orgs';
import { getEnv } from '$lib/server/env';
import { requireUser } from '$lib/server/access';

/** Open the first section allowed by the fixed space's existing permissions. */
export const load: PageServerLoad = async ({ locals, parent }) => {
	const env = getEnv();
	const user = requireUser(locals);
	const { orgs } = await parent();
	const workspace = env.WARCON_WORKSPACE_ID
		? orgs.find((entry) => entry.id === env.WARCON_WORKSPACE_ID)
		: orgs.length === 1
			? orgs[0]
			: undefined;
	const home = workspace ? orgHome(workspace, user.role === 'owner') : null;
	if (!home || user.apiKey) error(403, 'Management access required.');
	redirect(302, home);
};
