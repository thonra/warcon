import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Preserve old management bookmarks without forwarding legacy mutations. */
export const load: PageServerLoad = ({ request, params, url }) => {
	if (request.method !== 'GET') error(405, 'Method not allowed.');
	const path = (params.legacy ?? '').split('/').map(encodeURIComponent).join('/');
	redirect(308, `/manage/${path}${url.search}`);
};
