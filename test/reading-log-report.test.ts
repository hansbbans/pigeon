import * as assert from 'node:assert/strict';
import { test } from 'node:test';

// @ts-expect-error The report is a plain Node script without type declarations.
import { reportQueries } from '../scripts/reading-log-report.mjs';
import { createSchemaDatabase } from './helpers/sqlite-d1';

const SINCE = '2026-11-01T00:00:00.000Z';

function setup() {
	const { database } = createSchemaDatabase();
	database.exec("INSERT INTO feeds (feed_key, display_name) VALUES ('feed', 'Feed')");
	for (const id of ['a', 'b', 'c', 'd']) {
		database.prepare("INSERT INTO items (id, feed_key, subject, html_content, message_id, received_at) VALUES (?, 'feed', ?, '<p>x</p>', ?, '2026-11-01T00:00:00.000Z')").run(id, id, id);
	}
	let sequence = 0;
	const shown = (item: string, view: string, position: number, at: string, client = 'pigeon_web') => {
		sequence += 1;
		database.prepare(
			"INSERT INTO reading_log (id, event_key, event_type, item_id, feed_key, client_family, view, position, occurred_at) VALUES (?, ?, 'impression', ?, 'feed', ?, ?, ?, ?)",
		).run(`imp-${sequence}`, `imp-${sequence}`, item, client, view, position, at);
	};
	const event = (item: string, type: string, at: string, seconds: number | null = null) => {
		sequence += 1;
		database.prepare(
			"INSERT INTO engagement_events (id, event_key, item_id, feed_key, event_type, client_family, duration_seconds, occurred_at) VALUES (?, ?, ?, 'feed', ?, 'pigeon', ?, ?)",
		).run(`ev-${sequence}`, `ev-${sequence}`, item, type, seconds, at);
	};
	const run = (name: keyof ReturnType<typeof reportQueries>) =>
		database.prepare(reportQueries(SINCE)[name]).all().map((row) => ({ ...row })) as Array<Record<string, unknown>>;
	return { shown, event, run };
}

test('an open is credited only to the list it came from, not to every list the article later appeared in', () => {
	const { shown, event, run } = setup();
	shown('a', 'unread', 0, '2026-11-02T09:00:00.000Z');
	event('a', 'explicit_open', '2026-11-02T09:00:20.000Z');
	event('a', 'active_reading', '2026-11-02T09:01:00.000Z', 40);
	shown('a', 'for-you', 3, '2026-11-10T09:00:00.000Z');
	shown('a', 'recent', 0, '2026-11-10T09:05:00.000Z');
	shown('b', 'for-you', 4, '2026-11-10T09:00:00.000Z');

	assert.deepEqual(run('byView'), [
		{ view: 'for-you', items_shown: 2, opened_from_here: 0, of_those_read_15s: 0, open_pct: 0 },
		{ view: 'recent', items_shown: 1, opened_from_here: 0, of_those_read_15s: 0, open_pct: 0 },
		{ view: 'unread', items_shown: 1, opened_from_here: 1, of_those_read_15s: 1, open_pct: 100 },
	]);
});

test('For You positions are the position the article was opened from, not the best it ever had', () => {
	const { shown, event, run } = setup();
	shown('b', 'for-you', 30, '2026-11-02T09:00:00.000Z');
	event('b', 'explicit_open', '2026-11-02T09:00:05.000Z');
	event('b', 'active_reading', '2026-11-02T09:00:30.000Z', 20);
	shown('b', 'for-you', 0, '2026-11-03T09:00:00.000Z');
	shown('c', 'for-you', 1, '2026-11-03T09:00:00.000Z');

	assert.deepEqual(run('forYouByPosition'), [
		{ position: '1-5', times_shown: 2, opened_from_here: 0, of_those_read_15s: 0 },
		{ position: '21+', times_shown: 1, opened_from_here: 1, of_those_read_15s: 1 },
	]);
});

test('a card picked within its first second is still credited: the impression may land just after the open', () => {
	const { shown, event, run } = setup();
	event('c', 'explicit_open', '2026-11-02T09:00:00.000Z');
	shown('c', 'today', 2, '2026-11-02T09:00:00.400Z');
	event('d', 'explicit_open', '2026-11-02T09:00:00.000Z');
	shown('d', 'today', 3, '2026-11-02T09:00:11.000Z');

	assert.deepEqual(run('byView'), [{ view: 'today', items_shown: 2, opened_from_here: 1, of_those_read_15s: 0, open_pct: 50 }]);
});

test('totals count articles once however many lists showed them, and flag opens with no impression', () => {
	const { shown, event, run } = setup();
	for (const view of ['unread', 'today', 'for-you']) shown('a', view, 0, '2026-11-02T09:00:00.000Z');
	shown('b', 'unread', 1, '2026-11-02T09:00:00.000Z');
	event('a', 'explicit_open', '2026-11-02T09:00:03.000Z');
	event('d', 'explicit_open', '2026-11-02T10:00:00.000Z');
	event('d', 'active_reading', '2026-11-02T10:00:10.000Z', 9);
	event('d', 'active_reading', '2026-11-02T10:00:20.000Z', 9);

	assert.deepEqual(run('totals'), [{ items_shown: 2, items_opened: 2, opened_without_impression: 1, items_read_15s: 1 }]);
});

test('the window starts exactly at since, and the apps are told apart by impressions', () => {
	const { shown, event, run } = setup();
	shown('a', 'unread', 0, '2026-10-31T23:59:59.999Z');
	shown('a', 'unread', 0, '2026-11-01T00:00:00.001Z', 'pigeon_ios');
	shown('b', 'unread', 1, '2026-11-05T12:00:00.000Z', 'pigeon_web');
	event('a', 'explicit_open', '2026-10-31T23:59:59.999Z');
	event('b', 'explicit_open', '2026-11-05T12:00:02.000Z');

	assert.deepEqual(run('impressionsByClient'), [
		{ client: 'pigeon_ios', impressions: 1, latest: '2026-11-01T00:00:00.001Z' },
		{ client: 'pigeon_web', impressions: 1, latest: '2026-11-05T12:00:00.000Z' },
	]);
	assert.deepEqual(run('engagementByKind'), [{ client: 'pigeon', kind: 'explicit_open', events: 1, latest: '2026-11-05T12:00:02.000Z' }]);
	assert.deepEqual(run('byWeek').map((row) => [row.impressions, row.items_shown, row.items_opened]), [[1, 1, 0], [1, 1, 1]]);
	assert.throws(() => reportQueries("2026-11-01' OR 1=1 --"));
});
