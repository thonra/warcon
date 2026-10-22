import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Keep the existing management permissions within the panel's fixed scope. */
export const load: PageServerLoad = async ({ parent }) => {
	const { canManage, servers, orgs, scope } = await parent();
	if (!canManage) error(403, 'Server management access required.');
	return {
		managed: servers.filter((s) => s.manager),
		serverWorkspace:
			orgs.find((o) => o.id === scope?.id && o.role === 'owner' && !o.suspended) ?? null
	};
};
