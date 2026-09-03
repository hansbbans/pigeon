import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import app from '../src/index';
import { ensureDatabaseSchema } from '../src/migrations';
import {
	createLegacySchemaState,
	createCurrentSchemaState,
	maybeHandleSchemaAll,
	maybeHandleSchemaFirst,
	maybeHandleSchemaRun,
	type SchemaState,
} from './schema-test-helpers';

const FEED_SQL =
	'SELECT feed_key, display_name, from_email, custom_title, source_url, site_url, icon_url, last_item_at FROM feeds WHERE feed_key = ? AND is_active = 1';

const ITEMS_SQL =
	'SELECT id, message_id, subject, html_content, text_content, original_url, from_name, from_email, received_at FROM items WHERE feed_key = ? ORDER BY received_at DESC LIMIT ?';

const RAW_EMAIL = [
	'From: "Example Sender" <sender@example.com>',
	'To: pigeon@example.com',
	'Subject: Migration check',
	'Date: Wed, 01 Apr 2026 10:00:00 +0000',
	'Message-ID: <migration@example.com>',
	'MIME-Version: 1.0',
	'Content-Type: text/html; charset=UTF-8',
	'',
	'<html><body><a href="https://example.com/posts/migration-check">Read</a></body></html>',
].join('\r\n');

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com/</link>
    <item>
      <guid>item-1</guid>
      <title>First item</title>
      <link>https://example.com/posts/first-item</link>
      <description><![CDATA[<p>Hello world</p>]]></description>
      <pubDate>Fri, 20 Mar 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function missingColumnError(columnName: string): Error {
	return new Error(`no such column: ${columnName}`);
}

type SeedKind = 'feed' | 'article' | 'status';
type LegacyBackfillKind = 'itemStatus' | 'feedTag';

interface SeedMetrics {
	statements: Record<SeedKind, number>;
	inserted: Record<SeedKind, number>;
	sourceRowsRead: Record<SeedKind, number>;
}

function createSeedMetrics(): SeedMetrics {
	return {
		statements: { feed: 0, article: 0, status: 0 },
		inserted: { feed: 0, article: 0, status: 0 },
		sourceRowsRead: { feed: 0, article: 0, status: 0 },
	};
}

interface LegacyBackfillMetrics {
	statements: Record<LegacyBackfillKind, number>;
	inserted: Record<LegacyBackfillKind, number>;
	sourceRowsRead: Record<LegacyBackfillKind, number>;
}

function createLegacyBackfillMetrics(): LegacyBackfillMetrics {
	return {
		statements: { itemStatus: 0, feedTag: 0 },
		inserted: { itemStatus: 0, feedTag: 0 },
		sourceRowsRead: { itemStatus: 0, feedTag: 0 },
	};
}

interface VersionReadBarrier {
	wait(): Promise<void>;
}

function createVersionReadBarrier(expectedReads: number): VersionReadBarrier {
	let readCount = 0;
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});

	return {
		wait(): Promise<void> {
			readCount += 1;
			if (readCount >= expectedReads) {
				release();
			}
			return released;
		},
	};
}

interface SqliteD1SharedState {
	batchTail: Promise<void>;
	versionReadBarrier: VersionReadBarrier;
}

interface SqliteStatementSnapshot {
	sql: string;
	values: unknown[];
}

function seedKindForSql(sql: string): SeedKind | null {
	if (!sql.startsWith('INSERT INTO sync_changes')) {
		return null;
	}
	if (sql.includes("SELECT 'feed'")) return 'feed';
	if (sql.includes("SELECT 'article'")) return 'article';
	if (sql.includes("SELECT 'status'")) return 'status';
	return null;
}

function sourceTableForSeed(kind: SeedKind): string {
	return kind === 'feed' ? 'feeds' : kind === 'article' ? 'items' : 'item_statuses';
}

function legacyBackfillKindForSql(sql: string): LegacyBackfillKind | null {
	if (sql.startsWith('INSERT OR IGNORE INTO item_statuses') && sql.includes('CROSS JOIN items')) {
		return 'itemStatus';
	}
	if (sql.startsWith('INSERT OR IGNORE INTO feed_tags') && sql.includes('CROSS JOIN feeds')) {
		return 'feedTag';
	}
	return null;
}

function sourceTableForLegacyBackfill(kind: LegacyBackfillKind): string {
	return kind === 'itemStatus' ? 'items' : 'feeds';
}

class SqliteMigrationStatement {
	private values: unknown[] = [];

	constructor(
		private readonly database: DatabaseSync,
		private readonly sql: string,
		private readonly versionReadBarrier: VersionReadBarrier,
		private readonly executedSql: SqliteStatementSnapshot[],
	) {}

	bind(...values: unknown[]): this {
		this.values = values;
		return this;
	}

	snapshot(): SqliteStatementSnapshot {
		return { sql: this.sql, values: [...this.values] };
	}

	async first<T>(): Promise<T | null> {
		const row = (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
		if (this.sql === "SELECT value FROM _meta WHERE key = 'schema_version'") {
			await this.versionReadBarrier.wait();
		}
		return row;
	}

	async all<T>(): Promise<{ results: T[] }> {
		return { results: this.database.prepare(this.sql).all(...this.values) as T[] };
	}

	async run(): Promise<{ meta: { changes: number } }> {
		this.executedSql.push(this.snapshot());
		const result = this.database.prepare(this.sql).run(...this.values);
		return { meta: { changes: Number(result.changes) } };
	}
}

class SqliteMigrationDatabase {
	readonly metrics = createSeedMetrics();
	readonly legacyBackfillMetrics = createLegacyBackfillMetrics();
	readonly executedSql: SqliteStatementSnapshot[] = [];
	readonly batches: SqliteStatementSnapshot[][] = [];

	constructor(
		private readonly database: DatabaseSync,
		private readonly shared: SqliteD1SharedState,
	) {}

	prepare(sql: string): SqliteMigrationStatement {
		return new SqliteMigrationStatement(this.database, sql, this.shared.versionReadBarrier, this.executedSql);
	}

	async batch(statements: SqliteMigrationStatement[]): Promise<Array<{ meta: { changes: number } }>> {
		const previousBatch = this.shared.batchTail;
		let release!: () => void;
		this.shared.batchTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previousBatch;

		this.batches.push(statements.map((statement) => statement.snapshot()));
		this.database.exec('BEGIN IMMEDIATE');
		try {
			const results: Array<{ meta: { changes: number } }> = [];
			for (const statement of statements) {
				const snapshot = statement.snapshot();
				const kind = seedKindForSql(snapshot.sql);
				const legacyBackfillKind = legacyBackfillKindForSql(snapshot.sql);
				if (kind || legacyBackfillKind) {
					const currentVersion = this.database.prepare(
						"SELECT value FROM _meta WHERE key = 'schema_version'",
					).get() as { value: string } | undefined;
					const claim = String(snapshot.values[0] ?? '');
					if (currentVersion?.value === claim) {
						const sourceTable = kind
							? sourceTableForSeed(kind)
							: sourceTableForLegacyBackfill(legacyBackfillKind!);
						const sourceCount = this.database.prepare(`SELECT COUNT(*) AS count FROM ${sourceTable}`).get() as {
							count: number;
						};
						if (kind) {
							this.metrics.sourceRowsRead[kind] += Number(sourceCount.count);
						} else {
							this.legacyBackfillMetrics.sourceRowsRead[legacyBackfillKind!] += Number(sourceCount.count);
						}
					}
				}

				const result = await statement.run();
				if (kind) {
					this.metrics.statements[kind] += 1;
					this.metrics.inserted[kind] += result.meta.changes;
				}
				if (legacyBackfillKind) {
					this.legacyBackfillMetrics.statements[legacyBackfillKind] += 1;
					this.legacyBackfillMetrics.inserted[legacyBackfillKind] += result.meta.changes;
				}
				results.push(result);
			}
			this.database.exec('COMMIT');
			return results;
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		} finally {
			release();
		}
	}
}

class FailingV13MigrationDatabase extends SqliteMigrationDatabase {
	async batch(statements: SqliteMigrationStatement[]): Promise<Array<{ meta: { changes: number } }>> {
		if (statements.some((statement) => statement.sql.startsWith('CREATE TABLE IF NOT EXISTS maintenance_state'))) {
			throw new Error('simulated v13 migration failure');
		}
		return super.batch(statements);
	}
}

class LegacySchemaStatement {
	readonly sql: string;
	private readonly state: SchemaState;
	private readonly mode: 'feed' | 'email' | 'scheduled';
	private boundValues: unknown[] = [];

	constructor(sql: string, state: SchemaState, mode: LegacySchemaStatement['mode']) {
		this.sql = sql;
		this.state = state;
		this.mode = mode;
	}

	bind(...values: unknown[]): this {
		this.boundValues = values;
		return this;
	}

	snapshot(): { sql: string; values: unknown[] } {
		return {
			sql: this.sql,
			values: [...this.boundValues],
		};
	}

	async first<T>(): Promise<T | null> {
		const schema = maybeHandleSchemaFirst<T>(this.sql, this.boundValues, this.state);
		if (schema.handled) {
			return schema.value;
		}

		if (this.mode === 'scheduled' && this.sql.includes('SELECT cursor_feed_key')) {
			if (
				this.state.hasMaintenanceStateTable &&
				this.state.maintenanceClaimedDay === String(this.boundValues[1] ?? '') &&
				this.state.maintenanceClaimToken === String(this.boundValues[2] ?? '')
			) {
				return { cursor_feed_key: this.state.maintenanceCursorFeedKey } as T;
			}
			return null;
		}

		if (this.mode === 'feed' && this.sql === FEED_SQL) {
			if (!this.state.feedColumns.has('site_url')) {
				throw missingColumnError('site_url');
			}

			this.state.operations.push('feed-select');
			return {
				feed_key: 'example-feed',
				display_name: 'Example Feed',
				from_email: 'feed@example.com',
				custom_title: null,
				source_url: 'https://example.com/feed.xml',
				site_url: 'https://example.com/',
				icon_url: null,
				last_item_at: '2026-03-27T12:34:56.000Z',
			} as T;
		}

		throw new Error(`Unexpected SQL in first(): ${this.sql}`);
	}

	async all<T>(): Promise<{ results: T[] }> {
		const schema = maybeHandleSchemaAll<T>(this.sql, this.state);
		if (schema.handled) {
			return { results: schema.results };
		}

		if (this.mode === 'feed' && this.sql === ITEMS_SQL) {
			if (!this.state.itemColumns.has('original_url')) {
				throw missingColumnError('original_url');
			}

			this.state.operations.push('item-select');
			return {
				results: [
					{
						id: 'item-1',
						message_id: 'message-1',
						subject: 'First item',
						html_content: '<p>Hello world</p>',
						text_content: null,
						original_url: 'https://example.com/posts/first-item',
						from_name: 'Example Feed',
						from_email: 'feed@example.com',
						received_at: '2026-03-27T12:34:56.000Z',
					},
				] as T[],
			};
		}

		if (
			this.mode === 'scheduled' &&
			this.sql.includes('SELECT feed_key, source_url, etag, last_modified, fetch_interval_minutes')
		) {
			this.state.operations.push('cron-select');
			return {
				results: [
					{
						feed_key: 'example-feed',
						source_url: 'https://example.com/feed.xml',
						etag: null,
						last_modified: null,
						fetch_interval_minutes: 60,
					},
				] as T[],
			};
		}

		if (this.mode === 'scheduled' && this.sql.startsWith('SELECT feed_key FROM feeds')) {
			return { results: [{ feed_key: 'example-feed' }] as T[] };
		}

		if (this.mode === 'email' && this.sql.includes('FROM routing_rules')) {
			return { results: [] as T[] };
		}

		throw new Error(`Unexpected SQL in all(): ${this.sql}`);
	}

	async run(): Promise<void | { meta: { changes: number } }> {
		if (maybeHandleSchemaRun(this.sql, this.boundValues, this.state)) {
			return;
		}

		if (this.mode === 'scheduled' && this.sql.startsWith('UPDATE feeds SET last_fetched_at')) {
			this.state.operations.push('cron-update');
			return;
		}

		if (this.mode === 'scheduled' && this.sql.startsWith('UPDATE maintenance_state')) {
			if (this.sql.includes('SET claimed_day = ?, claim_token = ?, lease_until = ?')) {
				const [day, token, leaseUntil, jobName, expectedDay, now] = this.boundValues.map(String);
				const leaseAvailable =
					this.state.maintenanceClaimedDay === null ||
					this.state.maintenanceClaimToken === null ||
					this.state.maintenanceLeaseUntil === null ||
					this.state.maintenanceLeaseUntil <= now;
				const dayAvailable =
					this.state.maintenanceCompletedDay === null ||
					this.state.maintenanceCompletedDay < expectedDay;
				if (this.state.hasMaintenanceStateTable && jobName === 'daily_retention' && dayAvailable && leaseAvailable) {
					this.state.maintenanceClaimedDay = day;
					this.state.maintenanceClaimToken = token;
					this.state.maintenanceLeaseUntil = leaseUntil;
					this.state.operations.push('cron-retention-claim');
					return { meta: { changes: 1 } };
				}
				this.state.operations.push('cron-retention-loser');
				return { meta: { changes: 0 } };
			}

			if (this.sql.includes('SET completed_day = ?')) {
				const [day, cursorFeedKey, jobName, claimedDay, token] = this.boundValues;
				if (
					this.state.hasMaintenanceStateTable &&
					String(jobName) === 'daily_retention' &&
					this.state.maintenanceClaimedDay === String(claimedDay) &&
					this.state.maintenanceClaimToken === String(token)
				) {
					this.state.maintenanceCompletedDay = String(day);
					this.state.maintenanceCursorFeedKey = cursorFeedKey === null ? null : String(cursorFeedKey);
					this.state.maintenanceClaimedDay = null;
					this.state.maintenanceClaimToken = null;
					this.state.maintenanceLeaseUntil = null;
					this.state.operations.push('cron-retention-complete');
					return { meta: { changes: 1 } };
				}
				return { meta: { changes: 0 } };
			}

			if (this.sql.includes('SET claimed_day = NULL')) {
				const [jobName, claimedDay, token] = this.boundValues.map(String);
				if (
					this.state.hasMaintenanceStateTable &&
					jobName === 'daily_retention' &&
					this.state.maintenanceClaimedDay === claimedDay &&
					this.state.maintenanceClaimToken === token
				) {
					this.state.maintenanceClaimedDay = null;
					this.state.maintenanceClaimToken = null;
					this.state.maintenanceLeaseUntil = null;
					this.state.operations.push('cron-retention-release');
					return { meta: { changes: 1 } };
				}
				return { meta: { changes: 0 } };
			}
		}

		if (this.mode === 'scheduled' && this.sql.includes('SET refresh_lease_until = ?')) {
			this.state.operations.push('cron-lease');
			return { meta: { changes: 1 } };
		}

		if (this.mode === 'scheduled' && this.sql.startsWith('DELETE FROM refresh_activity')) {
			this.state.operations.push('cron-prune-activity');
			return;
		}

		if (this.mode === 'scheduled' && this.sql.startsWith('WITH retention_boundary AS')) {
			this.state.operations.push('cron-prune-content');
			return { meta: { changes: 0 } };
		}

		throw new Error(`Unexpected SQL in run(): ${this.sql}`);
	}
}

class LegacySchemaDb {
	readonly state: SchemaState;
	readonly batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
	private readonly mode: 'feed' | 'email' | 'scheduled';

	constructor(mode: LegacySchemaDb['mode'], state: SchemaState = createLegacySchemaState()) {
		this.mode = mode;
		this.state = state;
	}

	prepare(sql: string): LegacySchemaStatement {
		return new LegacySchemaStatement(sql, this.state, this.mode);
	}

	async batch(statements: LegacySchemaStatement[]): Promise<void | Array<void | { meta: { changes: number } }>> {
		if (statements.some((statement) => statement.sql.startsWith('CREATE TABLE IF NOT EXISTS maintenance_state'))) {
			for (const statement of statements) {
				const snapshot = statement.snapshot();
				if (snapshot.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_sync_changes_entity')) {
					this.state.operations.push('create-sync-entity-index');
				} else if (snapshot.sql.startsWith('CREATE TABLE IF NOT EXISTS maintenance_state')) {
					this.state.hasMaintenanceStateTable = true;
					this.state.operations.push('create-maintenance_state');
				} else if (snapshot.sql.startsWith('INSERT OR IGNORE INTO maintenance_state')) {
					this.state.hasMaintenanceStateTable = true;
					this.state.operations.push('seed-maintenance_state');
				} else if (snapshot.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_items_retention_rank')) {
					this.state.operations.push('create-retention-index');
				} else if (snapshot.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_items_starred_date')) {
					this.state.operations.push('create-starred-index');
				} else if (snapshot.sql === "UPDATE _meta SET value = ? WHERE key = 'schema_version' AND value = ?") {
					const nextValue = String(snapshot.values[0] ?? '');
					const expectedValue = String(snapshot.values[1] ?? '');
					if (nextValue === '13' && this.state.schemaVersion === expectedValue) {
						this.state.schemaVersion = nextValue;
						this.state.operations.push('set-schema-version:13');
					}
				}
			}
			return;
		}

		if (statements[0]?.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_sync_changes_entity')) {
			let claimed = false;
			for (const statement of statements) {
				const snapshot = statement.snapshot();
				if (snapshot.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_sync_changes_entity')) {
					this.state.operations.push('create-sync-entity-index');
					continue;
				}

				if (snapshot.sql === "UPDATE _meta SET value = ? WHERE key = 'schema_version' AND value = ?") {
					const nextValue = String(snapshot.values[0] ?? '');
					const expectedValue = String(snapshot.values[1] ?? '');
					if (nextValue.startsWith('__pigeon_schema_v') && this.state.schemaVersion === expectedValue) {
						this.state.schemaVersion = nextValue;
						claimed = true;
					}
					if (claimed && nextValue === '12' && this.state.schemaVersion === expectedValue) {
						this.state.schemaVersion = nextValue;
						this.state.operations.push('set-schema-version:12');
					}
					continue;
				}

				if (snapshot.sql.startsWith('INSERT INTO sync_changes') && claimed) {
					this.state.operations.push('seed-sync_changes');
				}
			}
			return;
		}

		if (statements.some((statement) => statement.sql.includes('SET completed_day = ?'))) {
			const results: Array<void | { meta: { changes: number } }> = [];
			for (const statement of statements) {
				results.push(await statement.run());
			}
			return results;
		}

		if (!this.state.feedColumns.has('site_url')) {
			throw missingColumnError('site_url');
		}
		if (!this.state.itemColumns.has('original_url')) {
			throw missingColumnError('original_url');
		}
		if (!this.state.hasFeedTagsTable) {
			throw new Error('no such table: feed_tags');
		}

		this.state.operations.push(this.mode === 'scheduled' ? 'rss-batch' : 'email-batch');
		this.batches.push(statements.map((statement) => statement.snapshot()));
	}
}

function createEnv(db: LegacySchemaDb) {
	return {
		API_PASSWORD: 'secret-password',
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '25',
		DB: db,
	};
}

function operationIndex(state: SchemaState, name: string): number {
	return state.operations.indexOf(name);
}

function postMetaMigrationOperations(state: SchemaState): string[] {
	return state.operations.filter((operation) => operation !== 'create-meta' && operation !== 'seed-meta');
}

test('fetch upgrades a legacy schema before reading feed rows that require site_url and original_url', async () => {
	const db = new LegacySchemaDb('feed');

	const response = await app.fetch(
		new Request('https://pigeon.example/feed/example-feed'),
		createEnv(db) as never,
	);

	assert.equal(response.status, 200);
	assert.equal(db.state.schemaVersion, '13');
	assert.equal(db.state.hasEngagementEventsTable, true);
	assert.equal(db.state.hasFeedTagsTable, true);
	assert.equal(db.state.hasFeedUrlAliasesTable, true);
	assert.equal(db.state.hasRefreshActivityTable, true);
	assert.equal(db.state.hasMaintenanceStateTable, true);
	assert.equal(db.state.hasItemStatusesTable, true);
	assert.equal(db.state.hasSyncChangesTable, true);
	assert.equal(db.state.hasMutationReceiptsTable, true);
	assert.ok(operationIndex(db.state, 'add-site_url') !== -1);
	assert.ok(operationIndex(db.state, 'add-original_url') !== -1);
	assert.ok(operationIndex(db.state, 'create-feed_tags') !== -1);
	assert.ok(operationIndex(db.state, 'create-engagement_events') !== -1);
	assert.ok(operationIndex(db.state, 'create-sync-entity-index') !== -1);
	for (const seedIndex of db.state.operations
		.map((operation, index) => (operation === 'seed-sync_changes' ? index : -1))
		.filter((index) => index !== -1)) {
		assert.ok(operationIndex(db.state, 'create-sync-entity-index') < seedIndex);
	}
	assert.ok(operationIndex(db.state, 'add-site_url') < operationIndex(db.state, 'feed-select'));
	assert.ok(operationIndex(db.state, 'add-original_url') < operationIndex(db.state, 'item-select'));
});

test('email upgrades a legacy schema before inserting feed and item rows with site_url and original_url', async () => {
	const db = new LegacySchemaDb('email');

	await app.email(
		{
			from: 'sender@example.com',
			to: 'pigeon@example.com',
			raw: new Blob([RAW_EMAIL]).stream(),
		} as unknown as ForwardableEmailMessage,
		createEnv(db) as never,
		{} as ExecutionContext,
	);

	assert.equal(db.state.schemaVersion, '13');
	assert.equal(db.state.hasEngagementEventsTable, true);
	assert.equal(db.state.hasFeedUrlAliasesTable, true);
	assert.equal(db.state.hasRefreshActivityTable, true);
	assert.equal(db.state.hasMaintenanceStateTable, true);
	assert.equal(db.state.hasItemStatusesTable, true);
	assert.equal(db.state.hasSyncChangesTable, true);
	assert.equal(db.state.hasMutationReceiptsTable, true);
	assert.equal(db.batches.length, 1);
	assert.ok(operationIndex(db.state, 'add-site_url') !== -1);
	assert.ok(operationIndex(db.state, 'add-original_url') !== -1);
	assert.ok(operationIndex(db.state, 'create-feed_tags') !== -1);
	assert.ok(operationIndex(db.state, 'create-engagement_events') !== -1);
	assert.ok(operationIndex(db.state, 'add-site_url') < operationIndex(db.state, 'email-batch'));
	assert.ok(operationIndex(db.state, 'add-original_url') < operationIndex(db.state, 'email-batch'));
});

test('scheduled upgrades a legacy schema before RSS refresh writes site_url and original_url', async () => {
	globalThis.fetch = (async () =>
		new Response(FEED_XML, {
			status: 200,
			headers: {
				'Content-Type': 'application/rss+xml',
				ETag: '"etag-1"',
				'Last-Modified': 'Fri, 20 Mar 2026 12:00:00 GMT',
			},
		})) as typeof fetch;

	const db = new LegacySchemaDb('scheduled');

	await app.scheduled({} as ScheduledController, createEnv(db) as never);

	assert.equal(db.state.schemaVersion, '13');
	assert.equal(db.state.hasEngagementEventsTable, true);
	assert.equal(db.state.hasFeedUrlAliasesTable, true);
	assert.equal(db.state.hasRefreshActivityTable, true);
	assert.equal(db.state.hasMaintenanceStateTable, true);
	assert.equal(db.state.hasItemStatusesTable, true);
	assert.equal(db.state.hasSyncChangesTable, true);
	assert.equal(db.state.hasMutationReceiptsTable, true);
	assert.equal(db.batches.length, 1);
	assert.ok(operationIndex(db.state, 'add-site_url') !== -1);
	assert.ok(operationIndex(db.state, 'add-original_url') !== -1);
	assert.ok(operationIndex(db.state, 'create-feed_tags') !== -1);
	assert.ok(operationIndex(db.state, 'create-engagement_events') !== -1);
	assert.ok(operationIndex(db.state, 'add-site_url') < operationIndex(db.state, 'cron-select'));
	assert.ok(operationIndex(db.state, 'add-original_url') < operationIndex(db.state, 'rss-batch'));
});

test('a fresh DB wrapper skips completed migrations using the persisted schema version', async () => {
	const persistedState = createLegacySchemaState();
	const firstDb = new LegacySchemaDb('feed', persistedState);

	const firstResponse = await app.fetch(
		new Request('https://pigeon.example/feed/example-feed'),
		createEnv(firstDb) as never,
	);

	assert.equal(firstResponse.status, 200);
	assert.equal(persistedState.schemaVersion, '13');
	assert.equal(persistedState.operations.filter((operation) => operation === 'seed-sync_changes').length, 3);

	persistedState.operations.length = 0;
	const secondDb = new LegacySchemaDb('feed', persistedState);
	const secondResponse = await app.fetch(
		new Request('https://pigeon.example/feed/example-feed'),
		createEnv(secondDb) as never,
	);

	assert.equal(secondResponse.status, 200);
	assert.deepEqual(
		persistedState.operations.filter((operation) => operation === 'seed-sync_changes'),
		[],
	);
	assert.deepEqual(postMetaMigrationOperations(persistedState), ['feed-select', 'item-select']);
});

test('a future schema version fails closed before touching an incomplete schema', async () => {
	const state = createLegacySchemaState();
	state.schemaVersion = '99';
	const db = new LegacySchemaDb('feed', state);

	const response = await app.fetch(
		new Request('https://pigeon.example/feed/example-feed'),
		createEnv(db) as never,
	);

	assert.equal(response.status, 503);
	assert.equal(state.schemaVersion, '99');
	assert.equal(state.hasSyncChangesTable, false);
	assert.equal(state.feedColumns.has('site_url'), false);
	assert.deepEqual(postMetaMigrationOperations(state), []);
});

test('a malformed schema version fails safely before migration work', async () => {
	const state = createCurrentSchemaState();
	state.schemaVersion = 'not-a-version';
	const db = new LegacySchemaDb('feed', state);

	const response = await app.fetch(
		new Request('https://pigeon.example/feed/example-feed'),
		createEnv(db) as never,
	);

	assert.equal(response.status, 503);
	assert.equal(state.schemaVersion, 'not-a-version');
	assert.deepEqual(postMetaMigrationOperations(state), []);
});

function createSqliteV11Fixture(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	database.exec(`
		INSERT INTO feeds (feed_key, display_name, source_type, is_active) VALUES
			('feed-a', 'Feed A', 'email', 1),
			('feed-b', 'Feed B', 'rss', 1),
			('feed-c', 'Feed C', 'email', 1);
		INSERT INTO items (id, feed_key, subject, html_content, text_content, message_id, received_at) VALUES
			('article-a', 'feed-a', 'Article A', '<p>A</p>', 'A', 'message-a', '2026-08-01T00:00:00.000Z'),
			('article-b', 'feed-a', 'Article B', '<p>B</p>', 'B', 'message-b', '2026-08-02T00:00:00.000Z'),
			('article-c', 'feed-b', 'Article C', '<p>C</p>', 'C', 'message-c', '2026-08-03T00:00:00.000Z'),
			('article-d', 'feed-c', 'Article D', '<p>D</p>', 'D', 'message-d', '2026-08-04T00:00:00.000Z');
		UPDATE feeds SET category = 'legacy-' || feed_key;
		DELETE FROM item_statuses;
		DELETE FROM feed_tags;
		DELETE FROM sync_changes;
		INSERT INTO sync_changes (entity_type, entity_id) VALUES
			('feed', 'feed-a'),
			('article', 'article-a'),
			('status', 'article-a');
		UPDATE _meta SET value = '11' WHERE key = 'schema_version';
		DROP INDEX idx_sync_changes_entity;
	`);
	return database;
}

test('SQLite v11 migration claims every source backfill once across independent wrappers', async () => {
	const database = createSqliteV11Fixture();
	const shared: SqliteD1SharedState = {
		batchTail: Promise.resolve(),
		versionReadBarrier: createVersionReadBarrier(2),
	};
	const firstDb = new SqliteMigrationDatabase(database, shared);
	const secondDb = new SqliteMigrationDatabase(database, shared);

	await Promise.all([
		ensureDatabaseSchema({ DB: firstDb } as never),
		ensureDatabaseSchema({ DB: secondDb } as never),
	]);

	const wrappers = [firstDb, secondDb];
	const winners = wrappers.filter(
		(wrapper) => Object.values(wrapper.metrics.inserted).some((count) => count > 0),
	);
	assert.equal(winners.length, 1);
	const winner = winners[0];
	assert.deepEqual(winner.metrics.inserted, { feed: 2, article: 3, status: 3 });
	assert.deepEqual(winner.metrics.sourceRowsRead, { feed: 3, article: 4, status: 4 });
	assert.deepEqual(winner.legacyBackfillMetrics.statements, { itemStatus: 1, feedTag: 1 });
	assert.deepEqual(winner.legacyBackfillMetrics.inserted, { itemStatus: 4, feedTag: 3 });
	assert.deepEqual(winner.legacyBackfillMetrics.sourceRowsRead, { itemStatus: 4, feedTag: 3 });

	const loser = wrappers.find((wrapper) => wrapper !== winner);
	assert.ok(loser);
	assert.deepEqual(loser.metrics.inserted, { feed: 0, article: 0, status: 0 });
	assert.deepEqual(loser.metrics.sourceRowsRead, { feed: 0, article: 0, status: 0 });
	assert.deepEqual(loser.legacyBackfillMetrics.statements, { itemStatus: 1, feedTag: 1 });
	assert.deepEqual(loser.legacyBackfillMetrics.inserted, { itemStatus: 0, feedTag: 0 });
	assert.deepEqual(loser.legacyBackfillMetrics.sourceRowsRead, { itemStatus: 0, feedTag: 0 });

	assert.equal(winner.batches.length, 2);
	const migrationBatch = winner.batches[0];
	assert.equal(migrationBatch[0]?.sql, 'CREATE INDEX IF NOT EXISTS idx_sync_changes_entity ON sync_changes(entity_type, entity_id)');
	const entityIndexPosition = migrationBatch.findIndex((statement) => statement.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_sync_changes_entity'));
	const claimPosition = migrationBatch.findIndex((statement) =>
		statement.sql.startsWith("UPDATE _meta SET value = ? WHERE key = 'schema_version' AND value = ?"),
	);
	for (const kind of ['itemStatus', 'feedTag'] as const) {
		const backfillPosition = migrationBatch.findIndex((statement) => legacyBackfillKindForSql(statement.sql) === kind);
		assert.ok(claimPosition < backfillPosition);
	}
	const firstSyncTriggerDropPosition = migrationBatch.findIndex((statement) =>
		statement.sql.startsWith('DROP TRIGGER IF EXISTS trg_sync_'),
	);
	const firstLegacyBackfillPosition = migrationBatch.findIndex((statement) =>
		Boolean(legacyBackfillKindForSql(statement.sql)),
	);
	assert.ok(claimPosition < firstSyncTriggerDropPosition);
	assert.ok(firstSyncTriggerDropPosition < firstLegacyBackfillPosition);
	for (const kind of ['feed', 'article', 'status'] as const) {
		const seedPosition = migrationBatch.findIndex((statement) => seedKindForSql(statement.sql) === kind);
		assert.ok(entityIndexPosition < seedPosition);
	}
	const lastSeedPosition = Math.max(
		...(['feed', 'article', 'status'] as const).map((kind) =>
			migrationBatch.findIndex((statement) => seedKindForSql(statement.sql) === kind),
		),
	);
	const firstSyncTriggerPosition = migrationBatch.findIndex((statement) =>
		statement.sql.startsWith('CREATE TRIGGER IF NOT EXISTS trg_sync_'),
	);
	const finalVersionPosition = migrationBatch.findIndex((statement) => statement.values[0] === '12');
	assert.ok(lastSeedPosition < firstSyncTriggerPosition);
	assert.ok(firstSyncTriggerPosition < finalVersionPosition);

	const schemaVersion = database.prepare(
		"SELECT value FROM _meta WHERE key = 'schema_version'",
	).get() as { value: string };
	assert.equal(schemaVersion.value, '13');

	const indexMigrationBatch = winner.batches[1];
	assert.equal(
		indexMigrationBatch[0]?.sql,
		'CREATE INDEX IF NOT EXISTS idx_sync_changes_entity ON sync_changes(entity_type, entity_id)',
	);
	assert.equal(indexMigrationBatch[1]?.sql, 'DROP INDEX IF EXISTS idx_items_unread');
	assert.equal(indexMigrationBatch[2]?.sql, 'DROP INDEX IF EXISTS idx_refresh_activity_feed');
	assert.match(indexMigrationBatch[3]?.sql ?? '', /^CREATE TABLE IF NOT EXISTS maintenance_state/);
	assert.equal(
		indexMigrationBatch[4]?.sql,
		"INSERT OR IGNORE INTO maintenance_state (job_name) VALUES ('daily_retention')",
	);
	assert.equal(
		indexMigrationBatch[5]?.sql,
		'CREATE INDEX IF NOT EXISTS idx_items_retention_rank ON items(feed_key, datetime(received_at) DESC, id DESC)',
	);
	assert.equal(
		indexMigrationBatch[6]?.sql,
		'CREATE INDEX IF NOT EXISTS idx_items_retention_candidates ON items(feed_key, datetime(received_at), id) WHERE content_pruned_at IS NULL AND is_read = 1 AND is_starred = 0',
	);
	assert.equal(
		indexMigrationBatch[7]?.sql,
		'CREATE INDEX IF NOT EXISTS idx_items_starred_date ON items(received_at DESC) WHERE is_starred = 1',
	);
	assert.equal(indexMigrationBatch[8]?.sql, 'CREATE INDEX IF NOT EXISTS idx_items_unread_feed ON items(feed_key) WHERE is_read = 0');
	assert.equal(indexMigrationBatch[9]?.sql, 'CREATE INDEX IF NOT EXISTS idx_items_unread_date ON items(received_at DESC) WHERE is_read = 0');
	assert.equal(indexMigrationBatch[10]?.sql, 'CREATE INDEX IF NOT EXISTS idx_items_read_date ON items(received_at DESC) WHERE is_read = 1');
	assert.equal(
		indexMigrationBatch[11]?.sql,
		'CREATE INDEX IF NOT EXISTS idx_refresh_activity_feed ON refresh_activity(feed_key, attempted_at DESC, id DESC)',
	);
	assert.equal(indexMigrationBatch[12]?.sql, "UPDATE _meta SET value = ? WHERE key = 'schema_version' AND value = ?");
	assert.deepEqual(indexMigrationBatch.at(-1)?.values, ['13', '12']);
	const maintenanceRow = database.prepare(
		'SELECT job_name, completed_day, claimed_day, claim_token, lease_until, cursor_feed_key FROM maintenance_state',
	).get() as Record<string, string | null>;
	assert.deepEqual({ ...maintenanceRow }, {
		job_name: 'daily_retention',
		completed_day: null,
		claimed_day: null,
		claim_token: null,
		lease_until: null,
		cursor_feed_key: null,
	});

	const indexes = database.prepare("PRAGMA index_list('sync_changes')").all() as Array<{
		name: string;
		unique: number;
	}>;
	const entityIndex = indexes.find((index) => index.name === 'idx_sync_changes_entity');
	assert.ok(entityIndex);
	assert.equal(entityIndex.unique, 0);
	const entityIndexColumns = database.prepare(
		"PRAGMA index_info('idx_sync_changes_entity')",
	).all() as Array<{ seqno: number; name: string }>;
	assert.deepEqual(
		entityIndexColumns.map(({ seqno, name }) => ({ seqno, name })),
		[
			{ seqno: 0, name: 'entity_type' },
			{ seqno: 1, name: 'entity_id' },
		],
	);

	const counts = database.prepare(
		'SELECT entity_type, COUNT(*) AS count FROM sync_changes GROUP BY entity_type',
	).all() as Array<{ entity_type: string; count: number }>;
	assert.deepEqual(
		Object.fromEntries(counts.map(({ entity_type, count }) => [entity_type, Number(count)])),
		{ article: 4, feed: 3, status: 4 },
	);
	const orderedChanges = database.prepare(
		'SELECT entity_type, entity_id FROM sync_changes ORDER BY sequence',
	).all() as Array<{ entity_type: string; entity_id: string }>;
	assert.deepEqual(orderedChanges.map(({ entity_type, entity_id }) => ({ entity_type, entity_id })), [
		{ entity_type: 'feed', entity_id: 'feed-a' },
		{ entity_type: 'article', entity_id: 'article-a' },
		{ entity_type: 'status', entity_id: 'article-a' },
		{ entity_type: 'feed', entity_id: 'feed-b' },
		{ entity_type: 'feed', entity_id: 'feed-c' },
		{ entity_type: 'article', entity_id: 'article-b' },
		{ entity_type: 'article', entity_id: 'article-c' },
		{ entity_type: 'article', entity_id: 'article-d' },
		{ entity_type: 'status', entity_id: 'article-b' },
		{ entity_type: 'status', entity_id: 'article-c' },
		{ entity_type: 'status', entity_id: 'article-d' },
	]);
	const legacyCounts = {
		itemStatus: Number((database.prepare('SELECT COUNT(*) AS count FROM item_statuses').get() as { count: number }).count),
		feedTag: Number((database.prepare('SELECT COUNT(*) AS count FROM feed_tags').get() as { count: number }).count),
	};
	assert.deepEqual(legacyCounts, { itemStatus: 4, feedTag: 3 });

	for (const kind of ['itemStatus', 'feedTag'] as const) {
		const backfill = winner.executedSql.find((statement) => legacyBackfillKindForSql(statement.sql) === kind);
		assert.ok(backfill);
		const plan = database.prepare(`EXPLAIN QUERY PLAN ${backfill.sql}`).all(...backfill.values) as Array<{
			detail: string;
		}>;
		const claimLookupPosition = plan.findIndex(({ detail }) => detail.includes('SEARCH m'));
		const sourceScanAlias = kind === 'itemStatus' ? 'SCAN i' : 'SCAN f';
		const sourceScanPosition = plan.findIndex(({ detail }) => detail.includes(sourceScanAlias));
		assert.ok(
			claimLookupPosition >= 0 && claimLookupPosition < sourceScanPosition,
			plan.map(({ detail }) => detail).join('\n'),
		);
	}

	const feedSeed = winner.executedSql.find((statement) => seedKindForSql(statement.sql) === 'feed');
	assert.ok(feedSeed);
	const plan = database.prepare(`EXPLAIN QUERY PLAN ${feedSeed.sql}`).all(...feedSeed.values) as Array<{
		detail: string;
	}>;
	assert.ok(
		plan.some(({ detail }) => detail.includes('idx_sync_changes_entity')),
		plan.map(({ detail }) => detail).join('\n'),
	);
	database.close();
});

function createSqliteV12Fixture(): DatabaseSync {
	const database = new DatabaseSync(':memory:');
	database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	database.exec(`
		DROP INDEX idx_items_retention_rank;
		DROP INDEX idx_items_retention_candidates;
		DROP INDEX idx_items_starred_date;
		DROP INDEX idx_items_unread_feed;
		DROP INDEX idx_items_unread_date;
		DROP INDEX idx_items_read_date;
		DROP INDEX idx_refresh_activity_feed;
		CREATE INDEX idx_items_unread ON items(is_read, feed_key);
		CREATE INDEX idx_refresh_activity_feed ON refresh_activity(feed_key, attempted_at DESC);
		DROP INDEX idx_sync_changes_entity;
		DROP TABLE maintenance_state;
		UPDATE _meta SET value = '12' WHERE key = 'schema_version';
	`);
	return database;
}

test('SQLite v12 migration creates only v13 indexes without legacy source scans', async () => {
	const database = createSqliteV12Fixture();
	const db = new SqliteMigrationDatabase(database, {
		batchTail: Promise.resolve(),
		versionReadBarrier: createVersionReadBarrier(1),
	});

	await ensureDatabaseSchema({ DB: db } as never);

	assert.equal(
		(database.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string }).value,
		'13',
	);
	assert.deepEqual(db.metrics.sourceRowsRead, { feed: 0, article: 0, status: 0 });
	assert.deepEqual(db.legacyBackfillMetrics.sourceRowsRead, { itemStatus: 0, feedTag: 0 });
	assert.equal(
		db.executedSql.some((statement) =>
			Boolean(seedKindForSql(statement.sql)) || Boolean(legacyBackfillKindForSql(statement.sql)),
		),
		false,
	);
	assert.equal(db.batches.length, 1);
	assert.equal(
		db.batches[0][0]?.sql,
		'CREATE INDEX IF NOT EXISTS idx_sync_changes_entity ON sync_changes(entity_type, entity_id)',
	);
	assert.equal(db.batches[0][1]?.sql, 'DROP INDEX IF EXISTS idx_items_unread');
	assert.equal(db.batches[0][2]?.sql, 'DROP INDEX IF EXISTS idx_refresh_activity_feed');
	assert.match(db.batches[0][3]?.sql ?? '', /^CREATE TABLE IF NOT EXISTS maintenance_state/);
	assert.equal(
		db.batches[0][4]?.sql,
		"INSERT OR IGNORE INTO maintenance_state (job_name) VALUES ('daily_retention')",
	);
	assert.equal(
		db.batches[0][5]?.sql,
		'CREATE INDEX IF NOT EXISTS idx_items_retention_rank ON items(feed_key, datetime(received_at) DESC, id DESC)',
	);
	assert.equal(
		db.batches[0][6]?.sql,
		'CREATE INDEX IF NOT EXISTS idx_items_retention_candidates ON items(feed_key, datetime(received_at), id) WHERE content_pruned_at IS NULL AND is_read = 1 AND is_starred = 0',
	);
	assert.equal(
		db.batches[0][7]?.sql,
		'CREATE INDEX IF NOT EXISTS idx_items_starred_date ON items(received_at DESC) WHERE is_starred = 1',
	);
	assert.equal(db.batches[0][8]?.sql, 'CREATE INDEX IF NOT EXISTS idx_items_unread_feed ON items(feed_key) WHERE is_read = 0');
	assert.equal(db.batches[0][9]?.sql, 'CREATE INDEX IF NOT EXISTS idx_items_unread_date ON items(received_at DESC) WHERE is_read = 0');
	assert.equal(db.batches[0][10]?.sql, 'CREATE INDEX IF NOT EXISTS idx_items_read_date ON items(received_at DESC) WHERE is_read = 1');
	assert.equal(
		db.batches[0][11]?.sql,
		'CREATE INDEX IF NOT EXISTS idx_refresh_activity_feed ON refresh_activity(feed_key, attempted_at DESC, id DESC)',
	);
	assert.equal(db.batches[0][12]?.sql, "UPDATE _meta SET value = ? WHERE key = 'schema_version' AND value = ?");
	assert.deepEqual(db.batches[0].at(-1)?.values, ['13', '12']);
	assert.equal(
		db.batches[0].some((statement) =>
			statement.sql.includes('INSERT INTO sync_changes') ||
			statement.sql.includes('INSERT OR IGNORE INTO item_statuses') ||
			statement.sql.includes('INSERT OR IGNORE INTO feed_tags') ||
			statement.sql.startsWith('DROP TRIGGER'),
		),
		false,
	);

	const indexes = database.prepare("PRAGMA index_list('items')").all() as Array<{ name: string }>;
	for (const indexName of [
		'idx_items_retention_rank',
		'idx_items_retention_candidates',
		'idx_items_starred_date',
		'idx_items_unread_feed',
		'idx_items_unread_date',
		'idx_items_read_date',
	]) {
		assert.ok(indexes.some(({ name }) => name === indexName), indexName);
	}
	const indexSql = database.prepare(
		"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?) ORDER BY name",
	).all('idx_items_retention_rank', 'idx_items_retention_candidates', 'idx_items_starred_date') as Array<{
		name: string;
		sql: string;
	}>;
	assert.match(indexSql.find(({ name }) => name === 'idx_items_retention_rank')?.sql ?? '', /datetime\(received_at\) DESC, id DESC/);
	assert.match(indexSql.find(({ name }) => name === 'idx_items_retention_candidates')?.sql ?? '', /content_pruned_at IS NULL/);
	assert.match(indexSql.find(({ name }) => name === 'idx_items_starred_date')?.sql ?? '', /WHERE is_starred = 1/);
	assert.equal(indexes.some(({ name }) => name === 'idx_items_unread'), false);
	const activityIndexColumns = database.prepare(
		"PRAGMA index_info('idx_refresh_activity_feed')",
	).all() as Array<{ seqno: number; name: string }>;
	assert.deepEqual(activityIndexColumns.map(({ seqno, name }) => ({ seqno, name })), [
		{ seqno: 0, name: 'feed_key' },
		{ seqno: 1, name: 'attempted_at' },
		{ seqno: 2, name: 'id' },
	]);
	const entityIndexColumns = database.prepare(
		"PRAGMA index_info('idx_sync_changes_entity')",
	).all() as Array<{ seqno: number; name: string }>;
	assert.deepEqual(entityIndexColumns.map(({ seqno, name }) => ({ seqno, name })), [
		{ seqno: 0, name: 'entity_type' },
		{ seqno: 1, name: 'entity_id' },
	]);
	const maintenanceRow = database.prepare(
		'SELECT job_name, completed_day, claimed_day, claim_token, lease_until, cursor_feed_key FROM maintenance_state',
	).get() as Record<string, string | null>;
	assert.deepEqual({ ...maintenanceRow }, {
		job_name: 'daily_retention',
		completed_day: null,
		claimed_day: null,
		claim_token: null,
		lease_until: null,
		cursor_feed_key: null,
	});
	database.close();
});

test('SQLite v12 migration serializes two cold wrappers without legacy scans', async () => {
	const database = createSqliteV12Fixture();
	const shared: SqliteD1SharedState = {
		batchTail: Promise.resolve(),
		versionReadBarrier: createVersionReadBarrier(2),
	};
	const firstDb = new SqliteMigrationDatabase(database, shared);
	const secondDb = new SqliteMigrationDatabase(database, shared);

	await Promise.all([
		ensureDatabaseSchema({ DB: firstDb } as never),
		ensureDatabaseSchema({ DB: secondDb } as never),
	]);

	for (const wrapper of [firstDb, secondDb]) {
		assert.equal(wrapper.batches.length, 1);
		assert.deepEqual(wrapper.metrics.sourceRowsRead, { feed: 0, article: 0, status: 0 });
		assert.deepEqual(wrapper.legacyBackfillMetrics.sourceRowsRead, { itemStatus: 0, feedTag: 0 });
		assert.equal(
			wrapper.executedSql.some((statement) =>
				Boolean(seedKindForSql(statement.sql)) || Boolean(legacyBackfillKindForSql(statement.sql)),
			),
			false,
		);
	}
	assert.equal(
		(database.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string }).value,
		'13',
	);
	assert.equal(
		database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_state'").get() !== undefined,
		true,
	);
	const entityIndexColumns = database.prepare(
		"PRAGMA index_info('idx_sync_changes_entity')",
	).all() as Array<{ seqno: number; name: string }>;
	assert.deepEqual(entityIndexColumns.map(({ seqno, name }) => ({ seqno, name })), [
		{ seqno: 0, name: 'entity_type' },
		{ seqno: 1, name: 'entity_id' },
	]);
	database.close();
});

test('SQLite v13 migration failures propagate instead of silently returning', async () => {
	const database = createSqliteV12Fixture();
	const db = new FailingV13MigrationDatabase(database, {
		batchTail: Promise.resolve(),
		versionReadBarrier: createVersionReadBarrier(1),
	});

	await assert.rejects(ensureDatabaseSchema({ DB: db } as never), /simulated v13 migration failure/);
	assert.equal(
		(database.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string }).value,
		'12',
	);
	database.close();
});
