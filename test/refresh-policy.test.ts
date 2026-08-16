import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	computeNextFetchAt,
	parseCacheControlMaxAge,
	parseRetryAfter,
	redactRefreshError,
	selectFeedsFairly,
	shouldUseConditionalRequest,
} from '../src/refresh-policy';

const NOW = new Date('2026-08-15T12:00:00.000Z');

test('successful refresh schedules are deterministic and bounded around the feed interval', () => {
	const input = {
		feedKey: 'example-feed',
		fetchIntervalMinutes: 60,
		consecutiveFailures: 4,
		outcome: 'success' as const,
	};
	const first = computeNextFetchAt(NOW, input);
	const second = computeNextFetchAt(NOW, input);
	assert.equal(first, second);
	const delayMinutes = (new Date(first).getTime() - NOW.getTime()) / 60_000;
	assert.ok(delayMinutes >= 54 && delayMinutes <= 66);
});

test('failures use exponential backoff with a one-day ceiling', () => {
	const firstFailure = computeNextFetchAt(NOW, {
		feedKey: 'feed',
		fetchIntervalMinutes: 60,
		consecutiveFailures: 0,
		outcome: 'network_error',
	});
	const fourthFailure = computeNextFetchAt(NOW, {
		feedKey: 'feed',
		fetchIntervalMinutes: 60,
		consecutiveFailures: 3,
		outcome: 'network_error',
	});
	const longFailure = computeNextFetchAt(NOW, {
		feedKey: 'feed',
		fetchIntervalMinutes: 60,
		consecutiveFailures: 100,
		outcome: 'network_error',
	});
	assert.ok(new Date(fourthFailure) > new Date(firstFailure));
	assert.ok(new Date(longFailure).getTime() - NOW.getTime() <= 86_400_000);
});

test('Retry-After supports seconds and dates and caps waits at one day', () => {
	assert.equal(parseRetryAfter('120', NOW), '2026-08-15T12:02:00.000Z');
	assert.equal(parseRetryAfter('Fri, 15 Aug 2026 13:00:00 GMT', NOW), '2026-08-15T13:00:00.000Z');
	assert.equal(parseRetryAfter('invalid', NOW), null);
	assert.equal(parseRetryAfter('999999', NOW), '2026-08-16T12:00:00.000Z');
});

test('successful schedules respect bounded Cache-Control freshness', () => {
	const cacheUntilAt = parseCacheControlMaxAge('public, max-age="7200"', NOW);
	assert.equal(cacheUntilAt, '2026-08-15T14:00:00.000Z');
	assert.equal(
		computeNextFetchAt(NOW, {
			feedKey: 'feed',
			fetchIntervalMinutes: 15,
			consecutiveFailures: 0,
			outcome: 'success',
			cacheUntilAt,
		}),
		'2026-08-15T14:00:00.000Z',
	);
	assert.equal(parseCacheControlMaxAge('no-cache', NOW), null);
	assert.equal(parseCacheControlMaxAge('max-age=999999', NOW), '2026-08-16T12:00:00.000Z');
});

test('conditional validators are periodically bypassed for a full response', () => {
	assert.equal(shouldUseConditionalRequest(NOW, null, true), false);
	assert.equal(shouldUseConditionalRequest(NOW, '2026-08-14T12:00:00.000Z', true), true);
	assert.equal(shouldUseConditionalRequest(NOW, '2026-08-01T12:00:00.000Z', true), false);
	assert.equal(shouldUseConditionalRequest(NOW, '2026-08-14T12:00:00.000Z', false), false);
});

test('fair selection round-robins hosts without changing per-host order', () => {
	const feeds = [
		{ feed_key: 'a-1', source_url: 'https://a.example/1' },
		{ feed_key: 'a-2', source_url: 'https://a.example/2' },
		{ feed_key: 'a-3', source_url: 'https://a.example/3' },
		{ feed_key: 'b-1', source_url: 'https://b.example/1' },
		{ feed_key: 'c-1', source_url: 'https://c.example/1' },
	];
	assert.deepEqual(
		selectFeedsFairly(feeds, 5).map((feed) => feed.feed_key),
		['a-1', 'b-1', 'c-1', 'a-2', 'a-3'],
	);
});

test('refresh errors redact URLs, query secrets, and excessive detail', () => {
	const redacted = redactRefreshError(
		new Error(`Failed https://private.example/feed?token=secret for editor@example.com ${'detail '.repeat(100)}`),
	);
	assert.doesNotMatch(redacted, /private|secret|editor@example\.com/);
	assert.match(redacted, /email redacted/);
	assert.ok(redacted.length <= 240);
});
