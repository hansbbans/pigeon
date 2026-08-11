import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { scoreRecommendation } from '../src/scoring';

const NOW = '2026-08-09T12:00:00.000Z';
const RECEIVED = '2026-08-09T11:00:00.000Z';

test('scoring is deterministic and starts with a recency explanation', () => {
	const input = {
		receivedAt: RECEIVED,
		now: NOW,
		isStarred: false,
		sampleCount: 0,
		feedSignals: {},
		itemSignals: {},
	};

	assert.deepEqual(scoreRecommendation(input), scoreRecommendation(input));
	assert.equal(scoreRecommendation(input).learningState, 'Starting with recency');
	assert.match(scoreRecommendation(input).explanation, /fresh|recency/i);
});

test('strong positive feedback outweighs ordinary read state and bulk mark-all is neutral', () => {
	const baseline = scoreRecommendation({
		receivedAt: RECEIVED,
		now: NOW,
		isStarred: false,
		sampleCount: 0,
		feedSignals: {},
		itemSignals: {},
	});
	const readState = scoreRecommendation({
		receivedAt: RECEIVED,
		now: NOW,
		isStarred: false,
		sampleCount: 1,
		feedSignals: { read: 1 },
		itemSignals: {},
	});
	const bulk = scoreRecommendation({
		receivedAt: RECEIVED,
		now: NOW,
		isStarred: false,
		sampleCount: 1,
		feedSignals: { bulk_mark_all_read: 1 },
		itemSignals: {},
	});
	const strongPositive = scoreRecommendation({
		receivedAt: RECEIVED,
		now: NOW,
		isStarred: false,
		sampleCount: 2,
		feedSignals: { read: 1, star: 1 },
		itemSignals: { active_reading: 1, outbound_link: 1, more_like_this: 1 },
	});
	const negative = scoreRecommendation({
		receivedAt: RECEIVED,
		now: NOW,
		isStarred: false,
		sampleCount: 1,
		feedSignals: { not_interested: 1 },
		itemSignals: {},
	});

	assert.equal(bulk.score, baseline.score);
	assert.ok(readState.score >= baseline.score);
	assert.ok(strongPositive.score > baseline.score);
	assert.ok(negative.score < baseline.score);
	assert.equal(strongPositive.confidence, 1 - Math.exp(-2 / 6));
});

test('active-reading score uses duration rather than heartbeat count', () => {
	const single = scoreRecommendation({
		receivedAt: RECEIVED,
		now: NOW,
		isStarred: false,
		sampleCount: 1,
		feedSignals: { active_reading: 1, activeReadingSeconds: 120, evidenceCount: 1 },
		itemSignals: {},
	});
	const repeated = scoreRecommendation({
		receivedAt: RECEIVED,
		now: NOW,
		isStarred: false,
		sampleCount: 1,
		feedSignals: { active_reading: 100, activeReadingSeconds: 120, evidenceCount: 1 },
		itemSignals: {},
	});

	assert.deepEqual(repeated, single);
});
