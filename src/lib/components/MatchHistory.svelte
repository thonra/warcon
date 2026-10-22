<script lang="ts">
	import { fmtDuration, fmtTime, prettify } from '$lib/format';
	import { fmtLength } from '$lib/matches';
	import type { MatchHistory } from '$lib/match-history';
	let { history }: { history: MatchHistory } = $props();
</script>

<section
	class="mt-4 rounded-ctl border border-black bg-ink-950 px-3.5 py-3"
	aria-label="Match evidence"
>
	<h3 class="caps text-mist-400">Match evidence</h3>
	<p class="mt-2 text-[12.5px] text-mist-400">
		{history.scores.samples} retained score observations · Source: RCON polling. Match boundaries are
		estimated from polling; times below are when Warcon observed or received data.
	</p>
	{#if history.scores.firstObservedAt && history.scores.lastObservedAt}
		<p class="mt-1 text-[12px] text-mist-600">
			Observed {fmtTime(history.scores.firstObservedAt)} – {fmtTime(history.scores.lastObservedAt)}.
			{#if history.scores.maxGapSeconds !== null}
				Largest gap between retained observations: {fmtLength(history.scores.maxGapSeconds)}.
			{/if}
			Gaps can include unchanged scores as well as missed observations.
		</p>
	{:else}
		<p class="mt-2 text-[12.5px] text-mist-600">
			No retained score history is available for this match.
		</p>
	{/if}
	{#if history.scores.truncated}
		<p class="mt-2 text-[12.5px] text-warn">
			This view shows the first {history.scores.samples} score observations; later history is omitted.
		</p>
	{/if}
	{#if history.scores.milestones.length}
		<div class="mt-3 grid gap-2 sm:grid-cols-2">
			{#each history.scores.milestones as point (point.threshold)}
				<div class="rounded-ctl border border-ink-700 px-3 py-2">
					<div class="text-[12.5px] text-mist-200">
						First observed at ≥ {point.threshold}: {point.factions.join(', ')}
					</div>
					<div class="mt-1 text-[12px] text-mist-400">{fmtTime(point.firstObservedAt)}</div>
					<p class="mt-1 text-[12px] text-mist-600">
						{#if point.previousBelowAt}Previous retained observation below {point.threshold}: {fmtTime(
								point.previousBelowAt
							)}.
						{:else}Already at this threshold in the first retained observation.{/if}
						The exact crossing time is unknown; this alone does not establish a rule violation.
					</p>
				</div>
			{/each}
		</div>
	{/if}

	<details class="mt-3">
		<summary class="cursor-pointer text-[12.5px] text-mist-200"
			>Game lifecycle events · {history.feed.events.length}</summary
		>
		<p class="mt-2 text-[12px] text-mist-600">
			Source: game event feed. Events must match the game instance and match IDs found in this
			match's linked kills, and fall within its recorded window. Late arrivals and events without
			that identity are omitted.
		</p>
		{#if history.feed.link === 'unavailable'}
			<p class="mt-2 text-[12.5px] text-mist-400">
				No linked kill identifies this match. Lifecycle history cannot be assigned safely.
			</p>
		{:else if history.feed.link === 'ambiguous'}
			<p class="mt-2 text-[12.5px] text-warn">
				Linked kills name more than one game match or server instance. Lifecycle history is withheld
				because the association is ambiguous.
			</p>
		{:else if !history.feed.events.length}
			<p class="mt-2 text-[12.5px] text-mist-400">
				No matching lifecycle events were retained in this window.
			</p>
		{:else}
			<div class="mt-2 table-wrap">
				<table>
					<thead><tr><th>Received</th><th>Game clock</th><th>Event</th><th>Detail</th></tr></thead>
					<tbody>
						{#each history.feed.events as event (`${event.receivedAt}:${event.eventId}`)}
							<tr>
								<td class="text-[12px] whitespace-nowrap text-mist-400"
									>{fmtTime(event.receivedAt)}</td
								>
								<td class="font-mono text-[12px]"
									>{event.eventTime === null ? '—' : fmtDuration(event.eventTime)}</td
								>
								<td class="whitespace-nowrap">{prettify(event.type)}</td>
								<td>
									{#if event.type === 'match_state'}{event.state ?? '—'}
									{:else}
										{event.winningFaction
											? `Winner: ${event.winningFaction}`
											: 'No winner reported'}
										{#if event.players !== null}
											· {event.players} players{/if}
										{#if event.scores}<span class="block text-[12px] text-mist-400"
												>{event.scores.map((f) => `${f.name} ${f.score}`).join(' · ')}</span
											>{/if}
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#if history.feed.truncated}<p class="mt-2 text-[12.5px] text-warn">
				Only the first {history.feed.events.length} lifecycle events are shown.
			</p>{/if}
	</details>
</section>
