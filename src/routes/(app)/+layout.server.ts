import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { flag, getEnv } from '$lib/server/env';
import { accessibleServers, canManage, userOrgs } from '$lib/server/access';
import { userCount } from '$lib/server/users';
import { getWorkspace } from '$lib/server/workspace';
import { enrolmentPolicy, statusFor } from '$lib/server/enrolment';

export const load: LayoutServerLoad = async ({ locals }) => {
	const env = getEnv();
	if (!locals.user) {
		redirect(303, (await userCount(env)) === 0 ? '/setup' : '/sign-in');
	}
	const [memberships, workspace] = await Promise.all([
		userOrgs(env, locals.user),
		getWorkspace(env)
	]);
	// The workspace is an installation setting. Old cookies and account preferences must not
	// hide its servers or select a different space. Server grants still decide actual access.
	const orgs = memberships.filter((o) => !workspace || o.id === workspace.id);
	const scope = workspace ? { id: workspace.id, name: workspace.name } : null;
	const servers = await accessibleServers(env, locals.user, workspace?.id ?? null);
	return {
		user: locals.user,
		orgs,
		scope,
		canManage: canManage(locals.user, orgs),
		servers,
		demoAllowed: flag(env.ALLOW_DEMO_SERVER, false),
		/** sign-in rules: how long until an incomplete account is limited to its account page */
		enrolment: statusFor(locals.user),
		/** whether the rules are enforced on this account, and whether to nag about them at all */
		authPolicy: await enrolmentPolicy(env, locals.user),
		steamLookup: !!env.STEAM_API_KEY
	};
};
