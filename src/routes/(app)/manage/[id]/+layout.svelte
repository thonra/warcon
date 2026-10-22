<script lang="ts">
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	let owner = $derived(data.listsRole.owner);
	let base = $derived(`/manage/${encodeURIComponent(data.org.id)}`);
	let current = $derived(page.url.pathname.slice(base.length) || '');

	/** path, label, and who sees it: owners only, anyone who opens a list, or one list's editors */
	const TABS = [
		['', 'Overview', 'owner'],
		['/servers', 'Servers', 'any'],
		['/access', 'Access', 'owner'],
		['/roles', 'Roles', 'owner'],
		['/seasons', 'Seasons', 'owner'],
		['/messages', 'Messages', 'owner'],
		['/map-sets', 'Map sets', 'owner'],
		['/players', 'Players', 'any'],
		['/bans', 'Ban list', 'ban'],
		['/reserved', 'Reserved slots', 'reserve']
	] as const;
	let tabs = $derived(
		TABS.filter(
			([, , who]) => who === 'any' || (who === 'owner' ? owner : data.listsRole.kinds.includes(who))
		)
	);
</script>

<svelte:head><title>Management · {data.appName}</title></svelte:head>

<h1 class="mb-4 text-xl font-semibold tracking-tight">Management</h1>

<nav class="strip mb-5 gap-1 border-b border-white/8 pb-3" aria-label="Management sections">
	{#each tabs as [path, label] (path)}
		<a
			href="{base}{path}"
			class="tab-link {current === path || (path && current.startsWith(`${path}/`))
				? 'tab-link-active'
				: ''}">{label}</a
		>
	{/each}
</nav>

{#key data.org.id}
	{@render children()}
{/key}
