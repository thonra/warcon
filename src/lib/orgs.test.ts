import { describe, expect, test } from 'bun:test';
import { orgHome, orgsLink, type OrgEntry } from './orgs';

const org = (over: Partial<OrgEntry> = {}): OrgEntry => ({
	id: 'o1',
	role: 'member',
	suspended: false,
	listKinds: [],
	...over
});
const owner = org({ role: 'owner', listKinds: ['ban', 'reserve'] });

describe('orgHome', () => {
	test('an owner lands on the overview', () => {
		expect(orgHome(owner, false)).toBe('/manage/o1');
	});
	test('a list holder lands on the ban list, or on the reserved slots when that is all they hold', () => {
		expect(orgHome(org({ listKinds: ['ban'] }), false)).toBe('/manage/o1/bans');
		expect(orgHome(org({ listKinds: ['reserve', 'ban'] }), false)).toBe('/manage/o1/bans');
		expect(orgHome(org({ listKinds: ['reserve'] }), false)).toBe('/manage/o1/reserved');
	});
	test('a member whose roles hold no list has no page to land on', () => {
		expect(orgHome(org(), false)).toBeNull();
	});
	test('a suspended org opens for the site owner only', () => {
		// userOrgs gives a suspended org no lists, and the Orgs page carries the suspension as an object
		const frozen = org({ role: 'owner', suspended: true });
		expect(orgHome(frozen, false)).toBeNull();
		expect(orgHome({ ...frozen, listKinds: ['ban', 'reserve'] }, false)).toBeNull();
		expect(orgHome({ ...frozen, suspended: { at: '2026-09-28', reason: '' } }, false)).toBeNull();
		expect(orgHome(frozen, true)).toBe('/manage/o1');
	});
	test('the id is a path segment of its own', () => {
		expect(orgHome(org({ id: 'a/b?c', role: 'owner' }), false)).toBe('/manage/a%2Fb%3Fc');
	});
});

describe('orgsLink', () => {
	test('a single management space opens its allowed section', () => {
		expect(orgsLink([owner], false)).toBe('/manage/o1');
		expect(orgsLink([org({ listKinds: ['reserve'] })], false)).toBe('/manage/o1/reserved');
	});
	test('the management entry point when no section is accessible', () => {
		expect(orgsLink([org()], false)).toBe('/manage');
		expect(orgsLink([org({ role: 'owner', suspended: true })], false)).toBe('/manage');
	});
	test('the management entry point for absent or ambiguous space', () => {
		expect(orgsLink([], false)).toBe('/manage');
		expect(orgsLink([owner, org({ id: 'o2', role: 'owner' })], false)).toBe('/manage');
	});
	test('the site owner also opens the fixed space directly', () => {
		expect(orgsLink([owner], true)).toBe('/manage/o1');
	});
});
