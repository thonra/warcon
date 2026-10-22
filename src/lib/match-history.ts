// History carries its source and gaps: a poll is an observation, not the instant a score changed.
export interface HistoryScore {
	name: string;
	score: number;
}

export function historyScores(value: unknown): HistoryScore[] | null {
	if (!Array.isArray(value) || !value.length) return null;
	const scores: HistoryScore[] = [];
	const names = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== 'object') return null;
		const { name, score } = item as Record<string, unknown>;
		if (
			typeof name !== 'string' ||
			!name ||
			names.has(name) ||
			typeof score !== 'number' ||
			!Number.isFinite(score)
		)
			return null;
		names.add(name);
		scores.push({ name, score });
	}
	return scores;
}

export interface ScoreMilestone {
	threshold: 20 | 40;
	/** Receipt time of the first retained observation at or above the threshold. */
	firstObservedAt: string;
	/** A crossing can only be bounded when the previous retained observation was below it. */
	previousBelowAt: string | null;
	factions: string[];
}

export interface MatchScoreHistory {
	source: 'poll';
	samples: number;
	truncated: boolean;
	firstObservedAt: string | null;
	lastObservedAt: string | null;
	maxGapSeconds: number | null;
	milestones: ScoreMilestone[];
}

export interface MatchHistoryEvent {
	source: 'game_feed';
	eventId: string;
	receivedAt: string;
	/** Clock sent by the game; it is not a UTC timestamp. */
	eventTime: number | null;
	instanceId: string;
	matchId: string;
	type: 'match_state' | 'match_ended';
	map: string;
	state: string | null;
	players: number | null;
	winningFaction: string | null;
	scores: HistoryScore[] | null;
}

export interface MatchHistory {
	scores: MatchScoreHistory;
	feed: {
		/** Existing matches have no persisted game identity; the linked kills are the evidence. */
		link: 'linked_kills' | 'unavailable' | 'ambiguous';
		events: MatchHistoryEvent[];
		truncated: boolean;
	};
}

export function describeScoreHistory(
	points: { ts: Date; scores: unknown }[],
	truncated: boolean
): MatchScoreHistory {
	const valid = points.flatMap((p) => {
		const scores = historyScores(p.scores);
		return scores ? [{ ts: p.ts, scores }] : [];
	});
	const milestones: ScoreMilestone[] = [];
	for (const threshold of [20, 40] as const) {
		const index = valid.findIndex((p) => p.scores.some((f) => f.score >= threshold));
		if (index < 0) continue;
		const first = valid[index];
		milestones.push({
			threshold,
			firstObservedAt: first.ts.toISOString(),
			previousBelowAt: index > 0 ? valid[index - 1].ts.toISOString() : null,
			factions: first.scores.filter((f) => f.score >= threshold).map((f) => f.name)
		});
	}
	let maxGapSeconds: number | null = null;
	for (let i = 1; i < valid.length; i++)
		maxGapSeconds = Math.max(
			maxGapSeconds ?? 0,
			(valid[i].ts.getTime() - valid[i - 1].ts.getTime()) / 1000
		);
	return {
		source: 'poll',
		samples: valid.length,
		truncated,
		firstObservedAt: valid[0]?.ts.toISOString() ?? null,
		lastObservedAt: valid.at(-1)?.ts.toISOString() ?? null,
		maxGapSeconds,
		milestones
	};
}
