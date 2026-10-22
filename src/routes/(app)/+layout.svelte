<script lang="ts">
	import { page } from '$app/state';
	import { afterNavigate } from '$app/navigation';
	import Mark from '$lib/components/Mark.svelte';
	import Pulse from '$lib/components/Pulse.svelte';
	import { health } from '$lib/health.svelte';
	import { initials } from '$lib/format';
	import { orgHome, orgsLink } from '$lib/orgs';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	let manageHref = $derived(orgsLink(data.orgs, data.user.role === 'owner'));
	let showManage = $derived(data.orgs.some((o) => orgHome(o, data.user.role === 'owner') !== null));

	let currentId = $derived(
		page.route.id?.includes('/server/[id]') ? (page.params.id ?? null) : null
	);
	// Server pages also supply their own permission-checked server details.
	let current = $derived(
		data.servers.find((s) => s.id === currentId) ??
			(currentId ? (page.data.server as (typeof data.servers)[number] | undefined) : undefined)
	);
	let switcherOpen = $state(false);
	let userOpen = $state(false);

	// Type-to-filter once the switcher is long enough to need it.
	let query = $state('');
	let searchable = $derived(data.servers.length > 8);
	let listed = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return data.servers;
		return data.servers.filter((s) =>
			`${s.name} ${s.host}:${s.port}`.toLowerCase().includes(needle)
		);
	});

	const isActive = (path: string) =>
		path === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(path);
	const closeAll = () => {
		switcherOpen = false;
		userOpen = false;
		query = '';
	};
	afterNavigate(closeAll);
</script>

<svelte:window onclick={closeAll} onkeydown={(e) => e.key === 'Escape' && closeAll()} />

<header class="sticky top-0 z-30 border-b border-black bg-ink-900">
	<div class="page-x flex h-[58px] items-center gap-3">
		<a
			href="/"
			class="flex shrink-0 items-center gap-2.5 font-semibold tracking-tight"
			aria-label="{data.appName} dashboard"
		>
			<Mark />
			<span
				class="font-display text-[19px] font-semibold tracking-[0.1em] uppercase {current
					? 'hidden sm:inline'
					: ''}">{data.appName}</span
			>
			<span class="hidden caps text-mist-600 sm:inline">rcon</span>
		</a>

		<div class="relative ml-1 min-w-0 flex-1 sm:flex-none">
			<button
				type="button"
				class="btn max-w-full gap-2 pr-2.5 text-[13px] font-medium tracking-normal normal-case sm:max-w-[260px]"
				aria-haspopup="menu"
				aria-expanded={switcherOpen}
				onclick={(e) => {
					e.stopPropagation();
					userOpen = false;
					switcherOpen = !switcherOpen;
				}}
			>
				<Pulse ok={current ? health[current.id] : undefined} />
				<span class="truncate">{current ? current.name : 'Select a server'}</span>
				<span class="text-[10px] text-mist-600">▼</span>
			</button>
			{#if switcherOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
				<div class="menu" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()}>
					{#if searchable}
						<div class="p-1 pb-1.5">
							<input
								class="input py-1.5 text-[13px]"
								type="search"
								placeholder="Find a server…"
								bind:value={query}
								aria-label="Find a server"
								{@attach (el) => el.focus()}
							/>
						</div>
					{/if}
					{#each listed as s (s.id)}
						<a
							href="/server/{encodeURIComponent(s.id)}"
							class="menu-item {s.id === currentId
								? 'border-accent! bg-accent/10 text-accent'
								: ''}"
							role="menuitem"
							onclick={closeAll}
						>
							<Pulse ok={health[s.id]} />
							<span class="truncate">{s.name}</span>
							<span class="ml-auto text-[11px] text-mist-600">{s.roleName}</span>
						</a>
					{:else}
						<div class="px-3 py-2 text-[12.5px] text-mist-400">
							{#if query.trim()}
								No server matches.
							{:else}
								{data.canManage ? 'No servers yet.' : 'No servers shared with you yet.'}
							{/if}
						</div>
					{/each}
					{#if data.canManage}
						<div class="my-1.5 border-t border-white/8"></div>
						<a href="/servers" class="menu-item text-mist-400" role="menuitem" onclick={closeAll}
							>Manage servers…</a
						>
					{/if}
				</div>
			{/if}
		</div>

		<nav class="ml-2 hidden items-center gap-1 md:flex" aria-label="Main">
			<a href="/" class="nav-pill {isActive('/') ? 'nav-pill-active' : ''}">Dashboard</a>
			<a href="/players" class="nav-pill {isActive('/players') ? 'nav-pill-active' : ''}">Players</a
			>
			<a href="/audit" class="nav-pill {isActive('/audit') ? 'nav-pill-active' : ''}">Audit</a>
			{#if data.canManage}
				<a href="/servers" class="nav-pill {isActive('/servers') ? 'nav-pill-active' : ''}"
					>Servers</a
				>
			{/if}
			{#if showManage}
				<a href={manageHref} class="nav-pill {isActive('/manage') ? 'nav-pill-active' : ''}"
					>Manage</a
				>
			{/if}
			{#if data.user.role === 'owner'}
				<a href="/admin" class="nav-pill {isActive('/admin') ? 'nav-pill-active' : ''}">Admin</a>
			{/if}
		</nav>

		<div class="relative ml-auto shrink-0">
			<button
				type="button"
				class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-ctl border border-black bg-accent text-[12px] font-bold text-ink-950"
				title="@{data.user.username}"
				aria-haspopup="menu"
				aria-expanded={userOpen}
				onclick={(e) => {
					e.stopPropagation();
					switcherOpen = false;
					userOpen = !userOpen;
				}}
			>
				{#if data.user.image}
					<img
						src={data.user.image}
						alt=""
						class="h-full w-full object-cover"
						referrerpolicy="no-referrer"
					/>
				{:else}
					{initials(data.user.name || data.user.username)}
				{/if}
			</button>
			{#if userOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
				<div
					class="menu right-0 left-auto max-sm:left-3"
					role="menu"
					tabindex="-1"
					onclick={(e) => e.stopPropagation()}
				>
					<div class="px-3 py-2">
						<div class="font-semibold">{data.user.name || data.user.username}</div>
						<div class="font-mono text-[12px] text-mist-400">
							@{data.user.username} · {data.user.role}
						</div>
					</div>
					<div class="my-1.5 border-t border-white/8"></div>
					<nav class="md:hidden" aria-label="Main (mobile)">
						<a href="/" class="menu-item" role="menuitem">Dashboard</a>
						<a href="/players" class="menu-item" role="menuitem">Players</a>
						<a href="/audit" class="menu-item" role="menuitem">Audit</a>
						{#if data.canManage}
							<a href="/servers" class="menu-item" role="menuitem">Servers</a>
						{/if}
						{#if showManage}<a href={manageHref} class="menu-item" role="menuitem">Manage</a>{/if}
						{#if data.user.role === 'owner'}
							<a href="/admin" class="menu-item" role="menuitem">Admin</a>
						{/if}
						<div class="my-1.5 border-t border-white/8"></div>
					</nav>
					<a href="/account" class="menu-item" role="menuitem">Account &amp; sessions</a>
					<form method="post" action="/sign-out">
						<button type="submit" class="menu-item text-mist-400" role="menuitem">Sign out</button>
					</form>
				</div>
			{/if}
		</div>
	</div>
</header>

{#if !data.user.authComplete && data.authPolicy.nudge && !data.user.apiKey && !page.url.pathname.startsWith('/account')}
	<div class="page-x pt-4">
		<a
			href="/account?enrol=1"
			class="flex flex-wrap items-center justify-between gap-2 rounded-ctl border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] hover:bg-warn/15"
		>
			<span>
				<span class="font-medium">Finish setting up your sign-in.</span>
				Two ways in, and an authenticator app on any password, so a lost device is not a lost account.
			</span>
			<span class="text-mist-400">
				{#if data.authPolicy.enforced && data.enrolment.daysLeft !== null}
					{data.enrolment.daysLeft} day{data.enrolment.daysLeft === 1 ? '' : 's'} left →
				{:else if data.authPolicy.enforced}
					Required →
				{:else}
					Recommended →
				{/if}
			</span>
		</a>
	</div>
{/if}

<main class="page-x py-6">
	{@render children()}
</main>
<footer class="page-x pb-6 text-[12px] text-mist-600">
	Map imagery &copy; BULKHEAD, from the official WARDOGS RCON console. Warcon is a community tool
	and is not affiliated with BULKHEAD or Team17.
	{#if data.supportUrl}
		<a
			href={data.supportUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="font-semibold text-accent hover:underline">Support {data.appName}</a
		>
	{/if}
</footer>
