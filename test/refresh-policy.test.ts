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

test('healthy feeds are polled by how recently they published', () => {
	const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
	const delayMinutes = (lastItemAt: string | null | undefined, outcome: 'success' | 'not_modified' = 'success') =>
		(new Date(computeNextFetchAt(NOW, {
			feedKey: 'example-feed',
			fetchIntervalMinutes: 60,
			consecutiveFailures: 0,
			outcome,
			lastItemAt,
		})).getTime() - NOW.getTime()) / 60_000;
	const within = (minutes: number, base: number) => minutes >= base * 0.9 && minutes <= base * 1.1;

	assert.ok(within(delayMinutes(hoursAgo(3)), 30), 'published in the last two days');
	assert.ok(within(delayMinutes(hoursAgo(3), 'not_modified'), 30), 'an unchanged response keeps the active cadence');
	assert.ok(within(delayMinutes(hoursAgo(5 * 24)), 60), 'published in the last two weeks');
	assert.ok(within(delayMinutes(hoursAgo(30 * 24)), 120), 'published in the last two months');
	assert.ok(within(delayMinutes(hoursAgo(400 * 24)), 240), 'dormant');
	assert.ok(within(delayMinutes(new Date(NOW.getTime() + 3_600_000).toISOString()), 30), 'a future-dated item counts as active');
	for (const unknown of [null, undefined, 'not a date']) {
		assert.ok(within(delayMinutes(unknown), 60), 'an unknown publish time keeps the configured interval');
	}
});

test('cadence never polls faster than fifteen minutes or changes failure backoff', () => {
	const recent = new Date(NOW.getTime() - 3_600_000).toISOString();
	const delay = (input: Partial<Parameters<typeof computeNextFetchAt>[1]>) =>
		(new Date(computeNextFetchAt(NOW, {
			feedKey: 'example-feed',
			fetchIntervalMinutes: 60,
			consecutiveFailures: 0,
			outcome: 'success',
			lastItemAt: recent,
			...input,
		})).getTime() - NOW.getTime()) / 60_000;

	const fastest = delay({ fetchIntervalMinutes: 15 });
	assert.ok(fastest >= 15 * 0.9 && fastest <= 15 * 1.1);
	const failure = delay({ outcome: 'network_error' });
	assert.ok(failure >= 54 && failure <= 66, 'a failing active feed retries on the configured interval');
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

test('selectFeedsFairly keeps due order across hosts instead of alphabetizing', () => {
	const feeds = ['zeit.de', 'a.com', 'b.com', 'c.com', 'd.com', 'e.com'].map((host) => ({
		feed_key: host,
		source_url: `https://${host}/feed`,
	}));
	assert.deepEqual(
		selectFeedsFairly(feeds, 5).map((feed) => feed.feed_key),
		['zeit.de', 'a.com', 'b.com', 'c.com', 'd.com'],
	);
});
