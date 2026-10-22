# Match evidence

Finished match pages now show the retained score observations and the game's lifecycle events below the score chart. The same view is available in the panel and, when public leaderboards are enabled, on the public match page. Existing access controls still apply.

## Score observations

The worker now saves a sample when a faction score changes, even before the normal sample heartbeat. Reordering factions or changing their colours does not create an extra sample.

The page shows the first and last retained observation, the largest interval between observations, and the first retained observation at or above 20 and 40 points. A preceding observation below the threshold gives an observation interval; it does not give the exact instant the threshold was crossed. When the first retained observation is already above the threshold, no earlier crossing time is inferred.

These are RCON polling observations. An interval can contain unchanged scores, a missed observation or a worker outage. Match boundaries are also estimated by polling. This evidence is useful for review but does not by itself prove a server-rule violation.

## Game lifecycle events

Stored `match_state` and `match_ended` events show the receipt time, the game-reported match clock, state, player count and result where present. The clock is a duration, not a UTC timestamp. The receipt time may be later than the game event.

Existing match rows do not persist the game's match ID or per-boot instance ID. This version therefore uses the match's linked kill rows as association evidence. There must be exactly one nonempty `(instanceId, matchId)` pair among that match's kills in its recorded time window and map. Events must match that exact pair, server and map, and have receipt timestamps in `[startedAt, endedAt)`.

No-kill matches cannot currently be linked this way. Multiple identities cause lifecycle history to be withheld as ambiguous. Late events, pre-match states without a match ID and events outside the recorded window are omitted. This deliberately favours incomplete history over mixing adjacent rounds. The interface explains these cases instead of presenting an empty list as proof that nothing happened.

## API additions and limits

The existing authenticated and public match detail responses include a new `history` field:

```ts
history: {
  scores: {
    source: 'poll';
    samples: number;
    truncated: boolean;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    maxGapSeconds: number | null;
    milestones: {
      threshold: 20 | 40;
      firstObservedAt: string;
      previousBelowAt: string | null;
      factions: string[];
    }[];
  };
  feed: {
    link: 'linked_kills' | 'unavailable' | 'ambiguous';
    truncated: boolean;
    events: {
      source: 'game_feed';
      eventId: string;
      receivedAt: string;
      eventTime: number | null;
      instanceId: string;
      matchId: string;
      type: 'match_state' | 'match_ended';
      map: string;
      state: string | null;
      players: number | null;
      winningFaction: string | null;
      scores: { name: string; score: number }[] | null;
    }[];
  };
}
```

Each response contains at most the first 5,000 score observations and 500 lifecycle events in chronological order. The corresponding `truncated` flag and page notice identify omitted later history. Score samples also require a matching map, mode and lighting when the match records those values. Invalid score arrays are treated as missing data rather than zero scores.

No database migration or new permission is required. Stored data is unchanged. The new observations improve history from deployment onward; missing earlier observations cannot be reconstructed.

## Verification

`src/test/score-samples.test.ts` drives the real observation worker against a scripted game and a temporary database: a score-only 19→20 change is persisted before the heartbeat, while order and colour changes are ignored.

`src/test/match-history.test.ts` exercises the existing detail endpoint and database queries with foreign servers, different game matches and server instances, map changes, boundary and late events, ambiguous identities and response limits. `src/lib/match-history.test.ts` covers milestone intervals and malformed or absent score data. Existing match detail and public-access tests remain applicable.
