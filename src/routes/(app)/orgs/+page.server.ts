import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Old bookmarks remain useful; form submissions are never forwarded. */
export const load: PageServerLoad = ({ request, url }) => {
	if (request.method !== 'GET') error(405, 'Method not allowed.');
	redirect(308, `/manage${url.search}`);
};
