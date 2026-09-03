import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
	READ_CONTENT_RETENTION_SQL,
	REFRESH_ACTIVITY_RETENTION_SQL,
	runDailyRetention,
} from '../src/cron-handler';

interface TestD1Result {
	meta: { changes: number };
}

interface TestD1Statement {
	sql: string;
	values: unknown[];
	bind(...values: unknown[]): TestD1Statement;
	run(): Promise<TestD1Result>;
	all<T>(): Promise<{ results: T[] }>;
	first<T>(): Promise<T | null>;
}

class RetentionD1Database {
	readonly executedSql: Array<{ sql: string; values: unknown[] }> = [];

	constructor(
		readonly database: DatabaseSync,
		private failBodyOnce = false,
	) {}

	prepare(sql: string): TestD1Statement {
		const owner = this;
		return {
			sql,
			values: [],
			bind(...boundValues: unknown[]) {
				this.values = boundValues;
				return this;
			},
			async run(): Promise<TestD1Result> {
				owner.executedSql.push({ sql, values: [...this.values] });
				if (owner.failBodyOnce && sql.startsWith('WITH retention_boundary AS')) {
					owner.failBodyOnce = false;
					throw new Error('simulated body retention failure');
				}
				const result = owner.database.prepare(sql).run(...this.values);
				return { meta: { changes: Number(result.changes) } };
			},
			async all<T>(): Promise<{ results: T[] }> {
				owner.executedSql.push({ sql, values: [...this.values] });
				return { results: owner.database.prepare(sql).all(...this.values) as T[] };
			},
			async first<T>(): Promise<T | null> {
				owner.executedSql.push({ sql, values: [...this.values] });
				return (owner.database.prepare(sql).get(...this.values) as T | undefined) ?? null;
			},
		};
	}

	async batch(statements: TestD1Statement[]): Promise<TestD1Result[]> {
		this.database.exec('BEGIN IMMEDIATE');
		try {
			const results: TestD1Result[] = [];
			for (const statement of statements) {
				results.push(await statement.run());
			}
			this.database.exec('COMMIT');
			return results;
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}
}

function createRetentionDatabase(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	return database;
}

function insertFeed(database: DatabaseSync, feedKey: string): void {
	database.prepare(
		`INSERT INTO feeds (feed_key, display_name, source_type, source_url)
		 VALUES (?, ?, 'rss', ?)`,
	).run(feedKey, feedKey, `https://example.com/${feedKey}`);
}

function claimMaintenance(database: DatabaseSync, day: string, token: string): void {
	database.prepare(
		`UPDATE maintenance_state
		 SET claimed_day = ?, claim_token = ?, lease_until = ?
		 WHERE job_name = 'daily_retention'`,
	).run(day, token, `${day}T23:59:59.000Z`);
}

function runBodyRetention(
	database: DatabaseSync,
	feedKey: string,
	now = '2026-08-15T12:00:00.000Z',
	day = '2026-08-15',
	token = 'test-token',
): void {
	claimMaintenance(database, day, token);
	const cutoff = new Date(Date.parse(now) - 180 * 86_400_000).toISOString();
	database.prepare(READ_CONTENT_RETENTION_SQL).run(
		feedKey,
		199,
		feedKey,
		cutoff,
		500,
		now,
		'daily_retention',
		day,
		token,
	);
}

test('content retention preserves the newest 200 items plus old unread and starred bodies', () => {
	const database = createRetentionDatabase();
	insertFeed(database, 'feed');
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

	runBodyRetention(database, 'feed');

	const row = (id: string) => database.prepare(
		'SELECT html_content, content_pruned_at FROM items WHERE id = ?',
	).get(id) as { html_content: string; content_pruned_at: string | null };
	assert.match(row('old-read').html_content, /no longer stored offline/);
	assert.equal(row('old-read').content_pruned_at, '2026-08-15T12:00:00.000Z');
	assert.equal(row('old-unread').content_pruned_at, null);
	assert.equal(row('old-starred').content_pruned_at, null);
	database.close();
});

test('content retention advances beyond an already-pruned 500-row batch', () => {
	const database = createRetentionDatabase();
	insertFeed(database, 'feed');
	const insert = database.prepare(
		`INSERT INTO items (
		  id, feed_key, subject, html_content, message_id, received_at, is_read, is_starred
		) VALUES (?, 'feed', ?, '<p>body</p>', ?, ?, 1, 0)`,
	);
	for (let index = 0; index < 1_400; index += 1) {
		const id = `item-${index.toString().padStart(4, '0')}`;
		insert.run(
			id,
			id,
			`message-${id}`,
			new Date(Date.parse('2026-08-15T12:00:00.000Z') - index * 86_400_000).toISOString(),
		);
	}

	for (const [day, expected] of [
		['2026-08-15', 500],
		['2026-08-16', 1_000],
		['2026-08-17', 1_200],
	] as const) {
		runBodyRetention(database, 'feed', `${day}T12:00:00.000Z`, day, `token-${day}`);
		const count = database.prepare(
			'SELECT COUNT(*) AS count FROM items WHERE content_pruned_at IS NOT NULL',
		).get() as { count: number };
		assert.equal(Number(count.count), expected);
	}
	database.close();
});

test('retention plans use bounded per-feed indexes instead of full-table scans', () => {
	const database = createRetentionDatabase();
	insertFeed(database, 'feed');
	claimMaintenance(database, '2026-08-15', 'test-token');
	const bodyPlan = database.prepare(`EXPLAIN QUERY PLAN ${READ_CONTENT_RETENTION_SQL}`).all(
		'feed', 199, 'feed', '2026-02-16T12:00:00.000Z', 500,
		'2026-08-15T12:00:00.000Z', 'daily_retention', '2026-08-15', 'test-token',
	) as Array<{ detail: string }>;
	const bodyDetails = bodyPlan.map(({ detail }) => detail).join('\n');
	assert.match(bodyDetails, /idx_items_retention_rank/);
	assert.match(bodyDetails, /idx_items_retention_candidates/);
	assert.doesNotMatch(bodyDetails, /SCAN items(?! USING INDEX)/);

	const activityPlan = database.prepare(`EXPLAIN QUERY PLAN ${REFRESH_ACTIVITY_RETENTION_SQL}`).all(
		'feed', '2026-07-16T12:00:00.000Z', 'feed', 500,
		'daily_retention', '2026-08-15', 'test-token',
	) as Array<{ detail: string }>;
	const activityDetails = activityPlan.map(({ detail }) => detail).join('\n');
	assert.match(activityDetails, /idx_refresh_activity_feed/);
	assert.doesNotMatch(activityDetails, /SCAN refresh_activity(?! USING INDEX)/);
	database.close();
});

test('GReader starred, unread, and read streams use bounded date indexes', () => {
	const database = createRetentionDatabase();
	insertFeed(database, 'feed');
	const streamSql = (predicate: string) =>
		`SELECT i.rowid, i.received_at
		   FROM items i
		   JOIN feeds f ON f.feed_key = i.feed_key
		  WHERE f.is_active = 1 AND ${predicate}
		  ORDER BY i.received_at DESC, i.rowid DESC
		  LIMIT ?`;
	for (const [predicate, indexName] of [
		['i.is_starred = 1', 'idx_items_starred_date'],
		['i.is_read = 0', 'idx_items_unread_date'],
		['i.is_read = 1', 'idx_items_read_date'],
	] as const) {
		const plan = database.prepare(`EXPLAIN QUERY PLAN ${streamSql(predicate)}`).all(50) as Array<{ detail: string }>;
		assert.match(plan.map(({ detail }) => detail).join('\n'), new RegExp(indexName));
	}

	const countPlan = database.prepare(
		`EXPLAIN QUERY PLAN SELECT i.feed_key, COUNT(*)
		 FROM feeds f JOIN items i ON i.feed_key = f.feed_key
		 WHERE f.is_active = 1 AND i.is_read = 0
		 GROUP BY i.feed_key`,
	).all() as Array<{ detail: string }>;
	assert.match(countPlan.map(({ detail }) => detail).join('\n'), /idx_items_unread_feed/);
	database.close();
});

test('daily retention has one winner, caps feed work, and advances its cursor atomically', async () => {
	const database = createRetentionDatabase();
	for (let index = 0; index < 8; index += 1) {
		insertFeed(database, `feed-${index.toString().padStart(2, '0')}`);
	}
	const first = new RetentionD1Database(database);
	const second = new RetentionD1Database(database);
	const results = await Promise.all([
		runDailyRetention(first as never, new Date('2026-08-15T00:42:00.000Z')),
		runDailyRetention(second as never, new Date('2026-08-15T00:43:00.000Z')),
	]);
	assert.deepEqual([...results].sort(), [false, true]);
	const bodyRuns = [...first.executedSql, ...second.executedSql]
		.filter(({ sql }) => sql.startsWith('WITH retention_boundary AS'));
	assert.equal(bodyRuns.length, 5);
	let row = database.prepare(
		'SELECT completed_day, claimed_day, claim_token, lease_until, cursor_feed_key FROM maintenance_state',
	).get() as Record<string, string | null>;
	assert.deepEqual({ ...row }, {
		completed_day: '2026-08-15',
		claimed_day: null,
		claim_token: null,
		lease_until: null,
		cursor_feed_key: 'feed-04',
	});

	assert.equal(await runDailyRetention(first as never, new Date('2026-08-15T23:59:00.000Z')), false);
	assert.equal(await runDailyRetention(first as never, new Date('2026-08-16T00:01:00.000Z')), true);
	const secondDayBodyRuns = first.executedSql.filter(
		({ sql, values }) => sql.startsWith('WITH retention_boundary AS') && values.includes('2026-08-16'),
	);
	assert.equal(secondDayBodyRuns.length, 3);
	row = database.prepare('SELECT completed_day, cursor_feed_key FROM maintenance_state').get() as Record<string, string | null>;
	assert.equal(row.completed_day, '2026-08-16');
	assert.equal(row.cursor_feed_key, null);
	database.close();
});

test('failed retention batches roll back cleanup, release the claim, and retry', async () => {
	const database = createRetentionDatabase();
	insertFeed(database, 'feed');
	database.exec(`
		INSERT INTO refresh_activity (
		  id, feed_key, attempted_at, completed_at, outcome, duration_ms
		) VALUES
		  ('old', 'feed', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:01.000Z', 'success', 100),
		  ('latest', 'feed', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:01.000Z', 'success', 100)
	`);
	const failing = new RetentionD1Database(database, true);
	const now = new Date('2026-08-15T13:42:00.000Z');
	await assert.rejects(runDailyRetention(failing as never, now), /simulated body retention failure/);
	assert.equal(
		Number((database.prepare('SELECT COUNT(*) AS count FROM refresh_activity').get() as { count: number }).count),
		2,
	);
	const released = database.prepare(
		'SELECT completed_day, claimed_day, claim_token, lease_until FROM maintenance_state',
	).get() as Record<string, string | null>;
	assert.deepEqual({ ...released }, {
		completed_day: null,
		claimed_day: null,
		claim_token: null,
		lease_until: null,
	});

	const healthy = new RetentionD1Database(database);
	assert.equal(await runDailyRetention(healthy as never, now), true);
	assert.equal(
		Number((database.prepare('SELECT COUNT(*) AS count FROM refresh_activity').get() as { count: number }).count),
		1,
	);
	database.close();
});

test('daily retention can recover an expired lease', async () => {
	const database = createRetentionDatabase();
	insertFeed(database, 'feed');
	database.prepare(
		`UPDATE maintenance_state
		 SET claimed_day = ?, claim_token = ?, lease_until = ?
		 WHERE job_name = 'daily_retention'`,
	).run('2026-08-15', 'stale-token', '2026-08-15T12:00:00.000Z');
	const retrying = new RetentionD1Database(database);
	assert.equal(await runDailyRetention(retrying as never, new Date('2026-08-15T13:42:00.000Z')), true);
	const row = database.prepare(
		'SELECT completed_day, claim_token FROM maintenance_state',
	).get() as { completed_day: string; claim_token: string | null };
	assert.equal(row.completed_day, '2026-08-15');
	assert.equal(row.claim_token, null);
	database.close();
});
