// Keep old bookmarks useful; accounts join through administrator-issued invitations.
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	redirect(303, locals.user ? '/manage' : '/sign-in');
};

const unavailable = async () =>
	fail(403, { error: 'Use an administrator invitation to join this panel.' });

export const actions: Actions = {
	discord: unavailable,
	steam: unavailable,
	register: unavailable,
	create: unavailable
};
