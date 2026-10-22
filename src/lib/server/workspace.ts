// A single management space, backed by the existing organisation and its unchanged permissions.
import { eq } from 'drizzle-orm';
import type { Env } from './env';
import type { Db } from './db';
import { organizations } from './db/schema';
import { ApiError } from './http';

type WorkspaceEnv = Pick<Env, 'WARCON_WORKSPACE_ID'>;

/** Resolve after migrations. Never guess between organisations or create/merge their data. */
export async function resolveWorkspaceId(db: Db, configured?: string): Promise<string> {
	const id = configured?.trim();
	if (id) {
		const [row] = await db
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.id, id))
			.limit(1);
		if (!row)
			throw new Error('WARCON_WORKSPACE_ID does not identify an existing management space.');
		return row.id;
	}
	const rows = await db.select({ id: organizations.id }).from(organizations).limit(2);
	if (rows.length === 1) return rows[0].id;
	if (!rows.length)
		throw new Error(
			'No management space exists. Restore the organisation data before starting Warcon.'
		);
	throw new Error(
		'Multiple organisations exist. Set WARCON_WORKSPACE_ID to the management space to use.'
	);
}

/** Internal metadata only; callers must still apply their existing membership/capability checks. */
export async function getWorkspace(env: Env): Promise<typeof organizations.$inferSelect | null> {
	if (!env.WARCON_WORKSPACE_ID) return null;
	const [row] = await env.db
		.select()
		.from(organizations)
		.where(eq(organizations.id, env.WARCON_WORKSPACE_ID))
		.limit(1);
	if (!row)
		throw new ApiError(
			503,
			'The configured management space is unavailable.',
			'workspace_unavailable'
		);
	return row;
}

/** Absent only in compatibility test fixtures; normal startup always fixes a workspace. */
export function assertWorkspaceMutable(env: WorkspaceEnv): void {
	if (env.WARCON_WORKSPACE_ID)
		throw new ApiError(403, 'This panel uses a fixed management space.', 'workspace_fixed');
}

/** A request for another stored organisation is unavailable, even to a site owner. */
export function assertWorkspaceTarget(env: WorkspaceEnv, orgId: string): void {
	if (env.WARCON_WORKSPACE_ID && orgId !== env.WARCON_WORKSPACE_ID)
		throw new ApiError(404, 'Organisation not found.', 'not_found');
}

/** Resolve the destination, never allowing a supplied different id to redirect a server add. */
export function serverWorkspaceId(env: WorkspaceEnv, requested: string): string {
	if (env.WARCON_WORKSPACE_ID) {
		if (requested && requested !== env.WARCON_WORKSPACE_ID)
			throw new ApiError(
				403,
				'Servers must use the configured management space.',
				'workspace_fixed'
			);
		return env.WARCON_WORKSPACE_ID;
	}
	if (!requested)
		throw new ApiError(400, 'orgId (the organisation that runs this server) is required.');
	return requested;
}
