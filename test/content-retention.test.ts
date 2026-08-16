import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { READ_CONTENT_RETENTION_SQL } from '../src/cron-handler';

test('content retention preserves unread and starred bodies while pruning old read bodies', () => {
	const database = new DatabaseSync(':memory:');
	database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	database.prepare(
		`INSERT INTO feeds (feed_key, display_name, source_type, source_url)
		 VALUES ('feed', 'Feed', 'rss', 'https://example.com/feed')`,
	).run();

	const insert = database.prepare(
		`INSERT INTO items (
		  id, feed_key, subject, html_content, message_id, received_at, is_read, is_starred
		) VALUES (?, 'feed', ?, ?, ?, ?, ?, ?)`,
	);
	for (let index = 0; index < 200; index += 1) {
		insert.run(
			`recent-${index}`,
			`Recent ${index}`,
			`<p>Recent ${index}</p>`,
			`recent-${index}`,
			new Date(Date.UTC(2026, 7, 15, 12, 0, index)).toISOString(),
			1,
			0,
		);
	}
	insert.run('old-read', 'Old read', '<p>Old read body</p>', 'old-read', '2025-01-01T00:00:00.000Z', 1, 0);
	insert.run('old-unread', 'Old unread', '<p>Old unread body</p>', 'old-unread', '2024-12-31T00:00:00.000Z', 0, 0);
	insert.run('old-starred', 'Old starred', '<p>Old starred body</p>', 'old-starred', '2024-12-30T00:00:00.000Z', 1, 1);

	database.prepare(READ_CONTENT_RETENTION_SQL).run(
		'2026-08-15T12:00:00.000Z',
		200,
		'2026-08-15T12:00:00.000Z',
		180,
		500,
	);

	const row = (id: string) => database.prepare(
		'SELECT html_content, content_pruned_at FROM items WHERE id = ?',
	).get(id) as { html_content: string; content_pruned_at: string | null };
	assert.match(row('old-read').html_content, /no longer stored offline/);
	assert.equal(row('old-read').content_pruned_at, '2026-08-15T12:00:00.000Z');
	assert.equal(row('old-unread').html_content, '<p>Old unread body</p>');
	assert.equal(row('old-unread').content_pruned_at, null);
	assert.equal(row('old-starred').html_content, '<p>Old starred body</p>');
	assert.equal(row('old-starred').content_pruned_at, null);
	database.close();
});
