import { describe, expect, test } from 'bun:test';
import { describeScoreHistory, historyScores } from './match-history';

describe('retained score evidence', () => {
	test('thresholds are observed intervals, with no invented earlier crossing', () => {
		const ts = (n: number) => new Date(n * 1000);
		const history = describeScoreHistory(
			[
				{ ts: ts(10), scores: [{ name: 'Blue', score: 19 }] },
				{ ts: ts(15), scores: [{ name: 'Blue', score: 20 }] },
				{ ts: ts(45), scores: [{ name: 'Blue', score: 41 }] }
			],
			false
		);
		expect(history.source).toBe('poll');
		expect(history.maxGapSeconds).toBe(30);
		expect(history.milestones).toEqual([
			{
				threshold: 20,
				firstObservedAt: ts(15).toISOString(),
				previousBelowAt: ts(10).toISOString(),
				factions: ['Blue']
			},
			{
				threshold: 40,
				firstObservedAt: ts(45).toISOString(),
				previousBelowAt: ts(15).toISOString(),
				factions: ['Blue']
			}
		]);
		expect(
			describeScoreHistory(
				[{ ts: ts(50), scores: [{ name: 'Blue', score: 60 }] }],
				true
			).milestones.every((m) => m.previousBelowAt === null)
		).toBe(true);
	});

	test('missing and invalid history is not presented as zero scores', () => {
		for (const value of [
			null,
			[],
			[{ name: 'Blue', score: '20' }],
			[{ name: 'Blue', score: NaN }],
			[
				{ name: 'Blue', score: 2 },
				{ name: 'Blue', score: 3 }
			]
		])
			expect(historyScores(value)).toBeNull();
		expect(describeScoreHistory([{ ts: new Date(), scores: null }], false)).toEqual({
			source: 'poll',
			samples: 0,
			truncated: false,
			firstObservedAt: null,
			lastObservedAt: null,
			maxGapSeconds: null,
			milestones: []
		});
	});
});
