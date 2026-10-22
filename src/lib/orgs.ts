// Management navigation. The org id remains an internal association for existing data.
import type { ListKind, OrgRole, OrgView } from './types';

/** The fixed management space with the signed-in person's permissions. */
export interface OrgEntry {
	id: string;
	role: OrgRole;
	suspended: boolean | OrgView['suspended'];
	/** Lists their roles open. */
	listKinds: readonly ListKind[];
}

/** The overview for an owner, else the first list their roles open; null when no section opens. */
export function orgHome(org: OrgEntry, siteOwner: boolean): string | null {
	const base = `/manage/${encodeURIComponent(org.id)}`;
	if (org.suspended && !siteOwner) return null;
	if (org.role === 'owner') return base;
	if (org.listKinds.includes('ban')) return `${base}/bans`;
	if (org.listKinds.includes('reserve')) return `${base}/reserved`;
	return null;
}

/**
 * The header receives only the fixed space. If absent or ambiguous, the server-side entry
 * point resolves it; there is no space picker or organisation list.
 */
export function orgsLink(orgs: readonly OrgEntry[], siteOwner: boolean): string {
	if (orgs.length !== 1) return '/manage';
	return orgHome(orgs[0], siteOwner) ?? '/manage';
}
