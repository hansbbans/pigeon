import * as assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { handleGreaderRequest } from '../src/greader';
import { generateApiToken } from '../src/api-auth';

const ITEM_ROW = {
	rowid: 1,
	id: '9c2772b1-1e53-4de8-89a6-77af6fb9c104',
	feed_key: 'sender-example-com',
	from_name: 'Example Sender',
	subject: 'Styled newsletter',
	html_content: '<div><p>Hello from a stored item.</p></div>',
	text_content: 'Hello from a stored item.',
	original_url: 'https://example.com/posts/styled-newsletter',
	received_at: '2026-03-20T12:34:56.000Z',
	is_read: 0,
	is_starred: 0,
};

const FEED_ROW = {
	rowid: 7,
	feed_key: 'sender-example-com',
	display_name: 'Example Sender',
	custom_title: null,
	category: 'Newsletters',
	source_url: 'https://example.com/feed.xml',
	site_url: 'https://example.com/',
};

async function generateAuthHeader(password: string): Promise<string> {
	const token = await generateApiToken(password);
	return `GoogleLogin auth=pigeon/${token}`;
}

class FakePreparedStatement {
	private readonly sql: string;

	constructor(sql: string) {
		this.sql = sql;
	}

	bind(..._values: unknown[]): this {
		return this;
	}

	async first<T>(): Promise<T | null> {
		if (this.sql.includes('SELECT feed_key FROM feeds WHERE rowid = ?')) {
			return { feed_key: FEED_ROW.feed_key } as T;
		}

		throw new Error(`Unexpected SQL in first(): ${this.sql}`);
	}

	async all<T>(): Promise<{ results: T[] }> {
		if (this.sql === 'PRAGMA table_info(feeds)') {
			return { results: migrationFeedColumns() as T[] };
		}

		if (this.sql === 'PRAGMA table_info(items)') {
			return { results: migrationItemColumns() as T[] };
		}

		if (this.sql.includes('COUNT(*) as count')) {
			return {
				results: [
					{
						rowid: FEED_ROW.rowid,
						feed_key: FEED_ROW.feed_key,
						count: 1,
						newest: ITEM_ROW.received_at,
					},
				] as T[],
			};
		}

		if (this.sql.includes('SELECT i.rowid, i.received_at FROM items i')) {
			return { results: [{ rowid: ITEM_ROW.rowid, received_at: ITEM_ROW.received_at }] as T[] };
		}

		if (this.sql.includes('SELECT i.rowid, i.id, i.feed_key')) {
			return { results: [ITEM_ROW] as T[] };
		}

		if (this.sql.includes('SELECT rowid, feed_key, display_name, custom_title, category, source_url, site_url FROM feeds')) {
			return { results: [FEED_ROW] as T[] };
		}

		if (this.sql.includes('JOIN feed_tags ft')) {
			return { results: [] as T[] };
		}

		if (this.sql.includes('SELECT feed_key, category')) {
			return { results: [{ feed_key: FEED_ROW.feed_key, category: FEED_ROW.category }] as T[] };
		}

		throw new Error(`Unexpected SQL in all(): ${this.sql}`);
	}

	async run(): Promise<void> {
		if (isMigrationSql(this.sql)) {
			return;
		}

		throw new Error(`Unexpected SQL in run(): ${this.sql}`);
	}
}

function migrationFeedColumns(): Array<{ name: string }> {
	return [
		'source_type',
		'source_url',
		'fetch_interval_minutes',
		'last_fetched_at',
		'fetch_error',
		'etag',
		'last_modified',
		'icon_url',
		'site_url',
		'category',
	].map((name) => ({ name }));
}

function migrationItemColumns(): Array<{ name: string }> {
	return [{ name: 'original_url' }];
}

function isMigrationSql(sql: string): boolean {
	return (
		sql.startsWith('CREATE TABLE IF NOT EXISTS _meta') ||
		sql.startsWith('INSERT OR IGNORE INTO _meta') ||
		sql.startsWith('ALTER TABLE feeds ADD COLUMN ') ||
		sql.startsWith('ALTER TABLE items ADD COLUMN ') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feeds_next_fetch') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feeds_refresh_due') ||
		sql.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_canonical_url') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS feed_url_aliases') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feed_url_aliases_') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS refresh_activity') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_refresh_activity_') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS item_statuses') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_item_statuses_') ||
		sql.startsWith('INSERT OR IGNORE INTO item_statuses') ||
		sql.startsWith('CREATE TRIGGER IF NOT EXISTS trg_items_') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS sync_changes') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_sync_changes_') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS mutation_receipts') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_mutation_receipts_') ||
		sql.startsWith('CREATE TRIGGER IF NOT EXISTS trg_sync_') ||
		sql.startsWith('INSERT INTO sync_changes') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS feed_tags') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feed_tags_label') ||
		sql.includes('CREATE TABLE IF NOT EXISTS engagement_events') ||
		sql.startsWith('ALTER TABLE engagement_events ADD COLUMN destination_host') ||
		sql.includes('CREATE INDEX IF NOT EXISTS idx_engagement_events_') ||
		(sql.startsWith('INSERT OR IGNORE INTO feed_tags') && sql.includes('SELECT feed_key, category')) ||
		sql.startsWith('UPDATE _meta SET value')
	);
}

function createEnv() {
	return {
		API_PASSWORD: 'secret-password',
		BASE_URL: 'https://pigeon.example',
		DB: {
			prepare(sql: string) {
				return new FakePreparedStatement(sql);
			},
		},
	};
}

function createLargeBatchEnv(itemCount: number) {
	const items = Array.from({ length: itemCount }, (_, index) => {
		const rowid = index + 1;
		const feedIndex = rowid;
		return {
			rowid,
			id: `item-${rowid}`,
			feed_key: `sender-example-${feedIndex}`,
			from_name: `Example Sender ${feedIndex}`,
			subject: `Styled newsletter ${rowid}`,
			html_content: `<div><p>Hello from stored item ${rowid}.</p></div>`,
			text_content: `Hello from stored item ${rowid}.`,
			original_url: `https://example.com/posts/${rowid}`,
			received_at: `2026-03-20T12:34:${String((rowid - 1) % 60).padStart(2, '0')}.000Z`,
			is_read: 0,
			is_starred: 0,
		};
	});

	const feeds = Array.from({ length: itemCount }, (_, index) => ({
		rowid: index + 1,
		feed_key: `sender-example-${index + 1}`,
		display_name: `Example Sender ${index + 1}`,
		custom_title: null,
		category: null,
		source_url: `https://example.com/feed-${index + 1}.xml`,
		site_url: `https://example.com/site-${index + 1}/`,
	}));

	return createReaderApiEnv(items, feeds);
}

function createPaginatedStreamEnv(itemCount: number) {
	const items = Array.from({ length: itemCount }, (_, index) => {
		const rowid = index + 1;
		return {
			rowid,
			id: `item-${rowid}`,
			feed_key: `sender-example-${rowid}`,
			from_name: `Example Sender ${rowid}`,
			subject: `Styled newsletter ${rowid}`,
			html_content: `<div><p>Hello from stored item ${rowid}.</p></div>`,
			text_content: `Hello from stored item ${rowid}.`,
			original_url: `https://example.com/posts/${rowid}`,
			received_at: new Date(Date.UTC(2026, 2, 20, 0, 0, rowid)).toISOString(),
			is_read: 0,
			is_starred: 0,
		};
	});
	const feeds = items.map((item) => ({
		rowid: item.rowid,
		feed_key: item.feed_key,
		display_name: `Example Sender ${item.rowid}`,
		custom_title: null,
		category: null,
		source_url: `https://example.com/feed-${item.rowid}.xml`,
		site_url: `https://example.com/site-${item.rowid}/`,
	}));

	return createReaderApiEnv(items, feeds);
}

function createReaderApiEnv(
	items: Array<typeof ITEM_ROW & { rowid: number; feed_key: string }>,
	feeds: Array<
		(typeof FEED_ROW & { feed_key: string }) & {
			category?: string | null;
			tags?: string[];
			is_active?: number;
		}
	>,
) {
	class ReaderApiPreparedStatement {
		private readonly sql: string;
		private values: unknown[] = [];

		constructor(sql: string) {
			this.sql = sql;
		}

		bind(...values: unknown[]): this {
			this.values = values;
			return this;
		}

		async first<T>(): Promise<T | null> {
			if (this.sql.includes('SELECT feed_key FROM feeds WHERE rowid = ?')) {
				const rowid = Number(this.values[0]);
				const feed = feeds.find((candidate) => candidate.rowid === rowid);
				return (feed ? { feed_key: feed.feed_key } : null) as T | null;
			}

			throw new Error(`Unexpected SQL in first(): ${this.sql}`);
		}

		async all<T>(): Promise<{ results: T[] }> {
			if (this.sql === 'PRAGMA table_info(feeds)') {
				return { results: migrationFeedColumns() as T[] };
			}

			if (this.sql === 'PRAGMA table_info(items)') {
				return { results: migrationItemColumns() as T[] };
			}

			if (this.sql.includes('COUNT(*) as count')) {
				const unreadByFeed = new Map<string, Array<(typeof items)[number]>>();
				for (const item of items) {
					const feed = feeds.find((candidate) => candidate.feed_key === item.feed_key);
					if (item.is_read || (feed?.is_active ?? 1) !== 1) {
						continue;
					}
					const feedItems = unreadByFeed.get(item.feed_key) ?? [];
					feedItems.push(item);
					unreadByFeed.set(item.feed_key, feedItems);
				}
				return {
					results: [...unreadByFeed.entries()].map(([feedKey, unreadItems]) => {
						const feed = feeds.find((candidate) => candidate.feed_key === feedKey);
						return {
							rowid: feed?.rowid ?? 0,
							feed_key: feedKey,
							count: unreadItems.length,
							newest: unreadItems.reduce(
								(newest, item) => (item.received_at > newest ? item.received_at : newest),
								unreadItems[0].received_at,
							),
						};
					}) as T[],
				};
			}

			if (this.sql.includes('SELECT i.rowid, i.received_at FROM items i')) {
				const limit = Number(this.values[this.values.length - 1]);
				const hasCursor = this.sql.includes('i.received_at < ? OR (i.received_at = ? AND i.rowid < ?)');
				const cursorReceivedAt = hasCursor ? String(this.values[this.values.length - 4]) : null;
				const cursorRowid = hasCursor ? Number(this.values[this.values.length - 2]) : null;
				const categoryFilter = this.sql.includes('f.category = ?')
					? String(this.values[0])
					: null;
				const feedKeyFilter =
					categoryFilter === null && this.sql.includes('AND i.feed_key = ?') ? String(this.values[0]) : null;
				return {
					results: items
						.filter((item) => {
							const feed = feeds.find((candidate) => candidate.feed_key === item.feed_key);
							if ((feed?.is_active ?? 1) !== 1) {
								return false;
							}
							if (feedKeyFilter !== null && item.feed_key !== feedKeyFilter) {
								return false;
							}
							if (this.sql.includes('AND i.is_starred = 1') && !item.is_starred) {
								return false;
							}
							if (this.sql.includes('AND i.is_read = 1') && !item.is_read) {
								return false;
							}
							if (this.sql.includes('AND i.is_read = 0') && item.is_read) {
								return false;
							}
							if (categoryFilter === null) {
								return true;
							}

							return (feed?.category ?? null) === categoryFilter || Boolean(feed?.tags?.includes(categoryFilter));
						})
						.filter((item) =>
							cursorReceivedAt === null || cursorRowid === null
								? true
								: item.received_at < cursorReceivedAt ||
									(item.received_at === cursorReceivedAt && item.rowid < cursorRowid),
						)
						.sort(
							(left, right) =>
								right.received_at.localeCompare(left.received_at) || right.rowid - left.rowid,
						)
						.slice(0, limit)
						.map((item) => ({ rowid: item.rowid, received_at: item.received_at })) as T[],
				};
			}

			if (this.sql.includes('SELECT i.rowid, i.id, i.feed_key')) {
				const placeholderCount = (this.sql.match(/\?/g) || []).length;
				assert.ok(
					placeholderCount <= 100,
					`expected batched item lookup to stay within D1 parameter limit, got ${placeholderCount}`,
				);
				const requestedRowIds = new Set(this.values.map((value) => Number(value)));
				return {
					results: items.filter((item) => requestedRowIds.has(item.rowid)) as T[],
				};
			}

			if (this.sql.includes('SELECT rowid, feed_key, display_name, custom_title, category, source_url, site_url FROM feeds')) {
				const placeholderCount = (this.sql.match(/\?/g) || []).length;
				assert.ok(
					placeholderCount <= 100,
					`expected batched feed lookup to stay within D1 parameter limit, got ${placeholderCount}`,
				);
				const requestedFeedKeys = new Set(this.values.map((value) => String(value)));
				return {
					results: feeds.filter((feed) => requestedFeedKeys.size === 0 || requestedFeedKeys.has(feed.feed_key)) as T[],
				};
			}

			if (this.sql.includes('SELECT rowid, feed_key, display_name, from_email, custom_title, category, icon_url, source_url, site_url FROM feeds WHERE is_active = 1')) {
				return {
					results: feeds
						.filter((feed) => (feed.is_active ?? 1) === 1)
						.map((feed) => ({
							...feed,
							from_email: null,
							icon_url: null,
						})) as T[],
				};
			}

			if (this.sql.includes('JOIN feed_tags ft')) {
				const requestedFeedKeys = new Set(this.values.map((value) => String(value)));
				return {
					results: feeds.flatMap((feed) =>
						(feed.tags ?? [])
							.filter(() => requestedFeedKeys.size === 0 || requestedFeedKeys.has(feed.feed_key))
							.map((label) => ({ feed_key: feed.feed_key, label })),
					) as T[],
				};
			}

			if (this.sql.includes('SELECT feed_key, category')) {
				const requestedFeedKeys = new Set(this.values.map((value) => String(value)));
				return {
					results: feeds
						.filter((feed) => requestedFeedKeys.size === 0 || requestedFeedKeys.has(feed.feed_key))
						.filter((feed) => feed.category)
						.map((feed) => ({ feed_key: feed.feed_key, category: feed.category })) as T[],
				};
			}

			throw new Error(`Unexpected SQL in all(): ${this.sql}`);
		}

		async run(): Promise<void> {
			if (isMigrationSql(this.sql)) {
				return;
			}

			throw new Error(`Unexpected SQL in run(): ${this.sql}`);
		}
	}

	return {
		API_PASSWORD: 'secret-password',
		BASE_URL: 'https://pigeon.example',
		DB: {
			prepare(sql: string) {
				return new ReaderApiPreparedStatement(sql);
			},
		},
	};
}

function createEditTagEnv() {
	const batches: Array<{ sql: string; values: unknown[] }> = [];

	class EditTagPreparedStatement {
		private readonly sql: string;
		private values: unknown[] = [];

		constructor(sql: string) {
			this.sql = sql;
		}

		bind(...values: unknown[]): this {
			this.values = values;
			return this;
		}

		record(): void {
			const placeholderCount = (this.sql.match(/\?/g) || []).length;
			assert.ok(
				placeholderCount <= 100,
				`expected edit-tag update to stay within D1 parameter limit, got ${placeholderCount}`,
			);
			batches.push({ sql: this.sql, values: this.values });
		}

		async all<T>(): Promise<{ results: T[] }> {
			if (this.sql === 'PRAGMA table_info(feeds)') {
				return { results: migrationFeedColumns() as T[] };
			}

			if (this.sql === 'PRAGMA table_info(items)') {
				return { results: migrationItemColumns() as T[] };
			}

			if (this.sql.includes('SELECT rowid, id, feed_key, is_read, is_starred FROM items')) {
				return { results: [] as T[] };
			}

			throw new Error(`Unexpected SQL in all(): ${this.sql}`);
		}

		async run(): Promise<void> {
			if (isMigrationSql(this.sql)) {
				return;
			}

			throw new Error(`Unexpected SQL in run(): ${this.sql}`);
		}
	}

	return {
		env: {
			API_PASSWORD: 'secret-password',
			BASE_URL: 'https://pigeon.example',
			DB: {
				prepare(sql: string) {
					return new EditTagPreparedStatement(sql);
				},
				async batch(stmts: EditTagPreparedStatement[]) {
					for (const stmt of stmts) {
						stmt.record();
					}
					return [];
				},
			},
		},
		batches,
	};
}

function createSubscriptionEditEnv() {
	const statements: Array<{ sql: string; values: unknown[] }> = [];

	class SubscriptionEditPreparedStatement {
		private readonly sql: string;
		private values: unknown[] = [];

		constructor(sql: string) {
			this.sql = sql;
		}

		bind(...values: unknown[]): this {
			this.values = values;
			return this;
		}

		async first<T>(): Promise<T | null> {
			if (this.sql.includes('SELECT feed_key FROM feeds WHERE rowid = ?')) {
				return { feed_key: FEED_ROW.feed_key } as T;
			}
			if (this.sql.includes('SELECT label FROM feed_tags WHERE feed_key = ?')) {
				return { label: 'Favorites' } as T;
			}
			throw new Error(`Unexpected SQL in first(): ${this.sql}`);
		}

		async all<T>(): Promise<{ results: T[] }> {
			if (this.sql === 'PRAGMA table_info(feeds)') {
				return { results: migrationFeedColumns() as T[] };
			}

			if (this.sql === 'PRAGMA table_info(items)') {
				return { results: migrationItemColumns() as T[] };
			}

			throw new Error(`Unexpected SQL in all(): ${this.sql}`);
		}

		async run(): Promise<void> {
			if (isMigrationSql(this.sql)) {
				return;
			}

			statements.push({ sql: this.sql, values: this.values });
		}
	}

	return {
		env: {
			API_PASSWORD: 'secret-password',
			BASE_URL: 'https://pigeon.example',
			DB: {
				prepare(sql: string) {
					return new SubscriptionEditPreparedStatement(sql);
				},
				async batch(stmts: SubscriptionEditPreparedStatement[]) {
					await Promise.all(stmts.map((stmt) => stmt.run()));
					return [];
				},
			},
		},
		statements,
	};
}

function createMarkAllAsReadEnv(
	items: Array<{ rowid: number; feed_key: string; received_at: string; is_read: number }>,
	feeds: Array<{ rowid: number; feed_key: string; category?: string | null; tags?: string[]; is_active?: number }>,
) {
	function cutoffMillis(value: unknown): number {
		return Number(String(value)) * 1000;
	}

	class MarkAllAsReadPreparedStatement {
		private readonly sql: string;
		private values: unknown[] = [];

		constructor(sql: string) {
			this.sql = sql;
		}

		bind(...values: unknown[]): this {
			this.values = values;
			return this;
		}

		async first<T>(): Promise<T | null> {
			if (this.sql.includes('SELECT feed_key FROM feeds WHERE rowid = ?')) {
				const rowid = Number(this.values[0]);
				const feed = feeds.find((candidate) => candidate.rowid === rowid);
				return (feed ? { feed_key: feed.feed_key } : null) as T | null;
			}

			throw new Error(`Unexpected SQL in first(): ${this.sql}`);
		}

		async all<T>(): Promise<{ results: T[] }> {
			if (this.sql === 'PRAGMA table_info(feeds)') {
				return { results: migrationFeedColumns() as T[] };
			}

			if (this.sql === 'PRAGMA table_info(items)') {
				return { results: migrationItemColumns() as T[] };
			}

			if (this.sql.includes('SELECT rowid FROM items WHERE feed_key = ?')) {
				const feedKey = String(this.values[0]);
				const cutoffMs = this.values.length > 1 ? cutoffMillis(this.values[1]) : null;
				return {
					results: items
						.filter((item) => item.feed_key === feedKey)
						.filter((item) => cutoffMs === null || Date.parse(item.received_at) <= cutoffMs)
						.map((item) => ({ rowid: item.rowid })) as T[],
				};
			}

			if (
				this.sql.includes('SELECT i.rowid') &&
				this.sql.includes('JOIN feeds f') &&
				this.sql.includes('WHERE f.is_active = 1') &&
				!this.sql.includes('f.category')
			) {
				const cutoffMs = this.values.length > 0 ? cutoffMillis(this.values[0]) : null;
				const activeFeedKeys = new Set(
					feeds
						.filter((feed) => (feed.is_active ?? 1) === 1)
						.map((feed) => feed.feed_key),
				);
				return {
					results: items
						.filter((item) => activeFeedKeys.has(item.feed_key))
						.filter((item) => cutoffMs === null || Date.parse(item.received_at) <= cutoffMs)
						.map((item) => ({ rowid: item.rowid })) as T[],
				};
			}

			if (this.sql.includes('SELECT i.rowid') && this.sql.includes('JOIN feeds f')) {
				const label = String(this.values[0]);
				const cutoffMs = this.values.length > 2 ? cutoffMillis(this.values[2]) : null;
				const matchingFeedKeys = new Set(
					feeds
						.filter((feed) => (feed.is_active ?? 1) === 1)
						.filter(
							(feed) =>
								(feed.category ?? null) === label || Boolean((feed.tags ?? []).includes(label)),
						)
						.map((feed) => feed.feed_key),
				);
				return {
					results: items
						.filter((item) => matchingFeedKeys.has(item.feed_key))
						.filter((item) => cutoffMs === null || Date.parse(item.received_at) <= cutoffMs)
						.map((item) => ({ rowid: item.rowid })) as T[],
				};
			}

			if (this.sql.includes('SELECT rowid FROM items WHERE 1 = 1')) {
				const cutoffMs = this.values.length > 0 ? cutoffMillis(this.values[0]) : null;
				return {
					results: items
						.filter((item) => cutoffMs === null || Date.parse(item.received_at) <= cutoffMs)
						.map((item) => ({ rowid: item.rowid })) as T[],
				};
			}

			if (this.sql.includes('SELECT rowid, id, feed_key, is_read, is_starred FROM items')) {
				const requestedRowIds = new Set(this.values.map((value) => Number(value)));
				return {
					results: items
						.filter((item) => requestedRowIds.has(item.rowid))
						.map((item) => ({
							rowid: item.rowid,
							id: `item-${item.rowid}`,
							feed_key: item.feed_key,
							is_read: item.is_read,
							is_starred: 0,
						})) as T[],
				};
			}

			throw new Error(`Unexpected SQL in all(): ${this.sql}`);
		}

		async run(): Promise<void> {
			if (isMigrationSql(this.sql)) {
				return;
			}

			if (this.sql.startsWith('INSERT OR IGNORE INTO engagement_events')) {
				return;
			}

			if (
				this.sql ===
					'UPDATE items SET is_read = 1 WHERE feed_key = ? AND feed_key IN (SELECT feed_key FROM feeds WHERE is_active = 1)'
			) {
				const feedKey = String(this.values[0]);
				const activeFeedKeys = new Set(
					feeds
						.filter((feed) => (feed.is_active ?? 1) === 1)
						.map((feed) => feed.feed_key),
				);
				for (const item of items) {
					if (item.feed_key === feedKey && activeFeedKeys.has(item.feed_key)) {
						item.is_read = 1;
					}
				}
				return;
			}

			if (
				this.sql ===
					"UPDATE items SET is_read = 1 WHERE feed_key = ? AND feed_key IN (SELECT feed_key FROM feeds WHERE is_active = 1) AND datetime(received_at) <= datetime(?, 'unixepoch')"
			) {
				const feedKey = String(this.values[0]);
				const cutoffMs = cutoffMillis(this.values[1]);
				const activeFeedKeys = new Set(
					feeds
						.filter((feed) => (feed.is_active ?? 1) === 1)
						.map((feed) => feed.feed_key),
				);
				for (const item of items) {
					if (item.feed_key === feedKey && activeFeedKeys.has(item.feed_key) && Date.parse(item.received_at) <= cutoffMs) {
						item.is_read = 1;
					}
				}
				return;
			}

			if (
				this.sql ===
					'UPDATE items SET is_read = 1 WHERE feed_key IN (SELECT feed_key FROM feeds WHERE is_active = 1)' ||
				this.sql ===
					"UPDATE items SET is_read = 1 WHERE feed_key IN (SELECT feed_key FROM feeds WHERE is_active = 1) AND datetime(received_at) <= datetime(?, 'unixepoch')"
			) {
				const cutoffMs = this.values.length > 0 ? cutoffMillis(this.values[0]) : null;
				const activeFeedKeys = new Set(
					feeds
						.filter((feed) => (feed.is_active ?? 1) === 1)
						.map((feed) => feed.feed_key),
				);
				for (const item of items) {
					if (!activeFeedKeys.has(item.feed_key)) {
						continue;
					}
					if (cutoffMs !== null && Date.parse(item.received_at) > cutoffMs) {
						continue;
					}
					item.is_read = 1;
				}
				return;
			}

			if (this.sql.startsWith('UPDATE items\n\t\t    SET is_read = 1\n\t\t  WHERE feed_key IN (')) {
				const label = String(this.values[0]);
				const cutoffMs = this.values.length > 2 ? cutoffMillis(this.values[2]) : null;
				const matchingFeedKeys = new Set(
					feeds
						.filter((feed) => (feed.is_active ?? 1) === 1)
						.filter(
							(feed) =>
								(feed.category ?? null) === label || Boolean((feed.tags ?? []).includes(label)),
						)
						.map((feed) => feed.feed_key),
				);
				for (const item of items) {
					if (!matchingFeedKeys.has(item.feed_key)) {
						continue;
					}
					if (cutoffMs !== null && Date.parse(item.received_at) > cutoffMs) {
						continue;
					}
					item.is_read = 1;
				}
				return;
			}

			if (this.sql === 'UPDATE items SET is_read = 1') {
				for (const item of items) {
					item.is_read = 1;
				}
				return;
			}

			if (this.sql === "UPDATE items SET is_read = 1 WHERE datetime(received_at) <= datetime(?, 'unixepoch')") {
				const cutoffMs = cutoffMillis(this.values[0]);
				for (const item of items) {
					if (Date.parse(item.received_at) <= cutoffMs) {
						item.is_read = 1;
					}
				}
				return;
			}

			throw new Error(`Unexpected SQL in run(): ${this.sql}`);
		}
	}

	return {
		env: {
			API_PASSWORD: 'secret-password',
			BASE_URL: 'https://pigeon.example',
			DB: {
				prepare(sql: string) {
					return new MarkAllAsReadPreparedStatement(sql);
				},
				async batch(stmts: MarkAllAsReadPreparedStatement[]) {
					for (const stmt of stmts) {
						await stmt.run();
					}
					return [];
				},
			},
		},
		items,
	};
}

function createSqliteMarkAllAsReadEnv(
	items: Array<{ rowid: number; feed_key: string; received_at: string; is_read: number }>,
	feeds: Array<{ rowid: number; feed_key: string; category?: string | null; is_active?: number }>,
) {
	const db = new DatabaseSync(':memory:');
	db.exec(`
		CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);
		INSERT INTO _meta (key, value) VALUES ('schema_version', '6');
		CREATE TABLE feeds (
			feed_key TEXT PRIMARY KEY,
			display_name TEXT,
			from_email TEXT,
			source_type TEXT NOT NULL DEFAULT 'email',
			source_url TEXT,
			site_url TEXT,
			fetch_interval_minutes INTEGER DEFAULT 60,
			last_fetched_at TEXT,
			fetch_error TEXT,
			etag TEXT,
			last_modified TEXT,
			first_seen_at TEXT,
			last_item_at TEXT,
			item_count INTEGER DEFAULT 0,
			is_active INTEGER DEFAULT 1,
			custom_title TEXT,
			category TEXT,
			icon_url TEXT
		);
		CREATE TABLE items (
			id TEXT PRIMARY KEY,
			feed_key TEXT NOT NULL,
			from_name TEXT,
			from_email TEXT,
			subject TEXT,
			html_content TEXT,
			text_content TEXT,
			original_url TEXT,
			message_id TEXT,
			received_at TEXT NOT NULL,
			created_at TEXT,
			content_size INTEGER DEFAULT 0,
			is_read INTEGER DEFAULT 0,
			is_starred INTEGER DEFAULT 0
		);
		CREATE TABLE feed_tags (
			feed_key TEXT NOT NULL,
			label TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (feed_key, label)
		);
	`);

	const insertFeed = db.prepare(
		`INSERT INTO feeds (
			rowid, feed_key, display_name, source_type, is_active, category
		) VALUES (?, ?, ?, 'email', ?, ?)`,
	);
	for (const feed of feeds) {
		insertFeed.run(
			feed.rowid,
			feed.feed_key,
			feed.feed_key,
			feed.is_active ?? 1,
			feed.category ?? null,
		);
	}

	const insertItem = db.prepare(
		`INSERT INTO items (
			rowid, id, feed_key, subject, html_content, received_at, is_read, is_starred
		) VALUES (?, ?, ?, 'Item', '<p>Body</p>', ?, ?, 0)`,
	);
	for (const item of items) {
		insertItem.run(item.rowid, `item-${item.rowid}`, item.feed_key, item.received_at, item.is_read);
	}

	class SqlitePreparedStatement {
		private readonly sql: string;
		private values: unknown[] = [];

		constructor(sql: string) {
			this.sql = sql;
		}

		bind(...values: unknown[]): this {
			this.values = values;
			return this;
		}

		async first<T>(): Promise<T | null> {
			const row = db.prepare(this.sql).get(...this.values) as T | undefined;
			return row ?? null;
		}

		async all<T>(): Promise<{ results: T[] }> {
			return {
				results: db.prepare(this.sql).all(...this.values) as T[],
			};
		}

		async run(): Promise<void> {
			db.prepare(this.sql).run(...this.values);
		}
	}

	return {
		db,
		env: {
			API_PASSWORD: 'secret-password',
			BASE_URL: 'https://pigeon.example',
			DB: {
				prepare(sql: string) {
					return new SqlitePreparedStatement(sql);
				},
				async batch(stmts: SqlitePreparedStatement[]) {
					for (const stmt of stmts) {
						await stmt.run();
					}
					return [];
				},
			},
		},
	};
}

async function markAllAsRead(
	env: ReturnType<typeof createMarkAllAsReadEnv>['env'],
	body: Record<string, string>,
): Promise<Response> {
	return handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/mark-all-as-read', {
			method: 'POST',
			headers: {
				Authorization: await generateAuthHeader('secret-password'),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams(body),
		}),
		env as never,
	);
}

test('ClientLogin accepts GET requests with query parameters for FreshRSS-style clients', async () => {
	const response = await handleGreaderRequest(
		new Request('https://pigeon.example/accounts/ClientLogin?Passwd=secret-password', {
			method: 'GET',
		}),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	assert.match(await response.text(), /^SID=pigeon\/.+\nLSID=null\nAuth=pigeon\/.+$/);
});

test('stream/items/ids returns decimal item references', async () => {
	const response = await handleGreaderRequest(
		new Request(
			'https://pigeon.example/reader/api/0/stream/items/ids?n=10000&xt=user/-/state/com.google/read&output=json&s=user/-/state/com.google/reading-list',
			{
				headers: {
					Authorization: await generateAuthHeader('secret-password'),
				},
			},
		),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.deepEqual(payload.itemRefs, [{ id: '1' }]);
});

test('subscription/edit stores repeated label additions and removals for a feed', async () => {
	const { env, statements } = createSubscriptionEditEnv();
	const form = new FormData();
	form.append('ac', 'edit');
	form.append('s', 'feed/7');
	form.append('a', 'user/-/label/Favorites');
	form.append('a', 'user/-/label/Work');
	form.append('r', 'user/-/label/Old');

	const response = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/subscription/edit', {
			method: 'POST',
			headers: {
				Authorization: await generateAuthHeader('secret-password'),
			},
			body: form,
		}),
		env as never,
	);

	assert.equal(response.status, 200);
	assert.equal(statements.filter((statement) => statement.sql.includes('INSERT OR IGNORE INTO feed_tags')).length, 2);
	assert.ok(
		statements.some(
			(statement) =>
				statement.sql.includes('DELETE FROM feed_tags') &&
				statement.values[0] === FEED_ROW.feed_key &&
				statement.values[1] === 'Old',
		),
	);
	assert.ok(
		statements.some(
			(statement) =>
				statement.sql.includes('UPDATE feeds SET category = COALESCE') &&
				statement.values[0] === 'Favorites',
		),
	);
	assert.ok(
		statements.some(
			(statement) =>
				statement.sql.includes('UPDATE feeds SET category = ? WHERE rowid = ?') &&
				statement.values[0] === 'Favorites' &&
				statement.values[1] === 7,
		),
	);
});

test('subscription/list returns every label for a feed', async () => {
	const response = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/subscription/list', {
			headers: {
				Authorization: await generateAuthHeader('secret-password'),
			},
		}),
		createReaderApiEnv(
			[],
			[
				{
					...FEED_ROW,
					rowid: 7,
					feed_key: 'alpha-feed',
					category: 'Daily Reads',
					tags: ['Daily Reads', 'Favorites'],
				},
				{
					...FEED_ROW,
					rowid: 8,
					feed_key: 'bravo-feed',
					display_name: 'Bravo',
					category: null,
					tags: ['Work'],
				},
			],
		) as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		subscriptions: [
			{
				id: 'feed/7',
				title: 'Example Sender',
				categories: [
					{ id: 'user/-/label/Daily Reads', label: 'Daily Reads' },
					{ id: 'user/-/label/Favorites', label: 'Favorites' },
				],
				url: 'https://pigeon.example/feed/alpha-feed',
				sourceUrl: 'https://example.com/feed.xml',
				htmlUrl: 'https://example.com/',
				iconUrl: '',
			},
			{
				id: 'feed/8',
				title: 'Bravo',
				categories: [{ id: 'user/-/label/Work', label: 'Work' }],
				url: 'https://pigeon.example/feed/bravo-feed',
				sourceUrl: 'https://example.com/feed.xml',
				htmlUrl: 'https://example.com/',
				iconUrl: '',
			},
		],
	});
});

test('tag/list returns every distinct label across subscriptions', async () => {
	const response = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/tag/list', {
			headers: {
				Authorization: await generateAuthHeader('secret-password'),
			},
		}),
		createReaderApiEnv(
			[],
			[
				{ ...FEED_ROW, rowid: 7, feed_key: 'alpha-feed', category: 'Daily Reads', tags: ['Daily Reads', 'Favorites'] },
				{ ...FEED_ROW, rowid: 8, feed_key: 'bravo-feed', category: null, tags: ['Work'] },
			],
		) as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		tags: [
			{ id: 'user/-/state/com.google/starred' },
			{ id: 'user/-/state/com.google/read' },
			{ id: 'user/-/state/com.google/reading-list' },
			{ id: 'user/-/label/Daily Reads' },
			{ id: 'user/-/label/Favorites' },
			{ id: 'user/-/label/Work' },
		],
	});
});

test('stream/items/contents returns a FreshRSS-style envelope with wrapped items', async () => {
	const form = new FormData();
	form.append('i', '1');

	const response = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/stream/items/contents', {
			method: 'POST',
			headers: {
				Authorization: await generateAuthHeader('secret-password'),
			},
			body: form,
		}),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.equal(payload.id, 'user/-/state/com.google/reading-list');
	assert.equal(typeof payload.updated, 'number');
	assert.equal(payload.items.length, 1);
	assert.equal(payload.items[0].id, 'tag:google.com,2005:reader/item/0000000000000001');
	assert.equal(payload.items[0].alternate[0].href, 'https://example.com/posts/styled-newsletter');
	assert.equal(payload.items[0].origin.streamId, 'feed/7');
	assert.equal(payload.items[0].origin.htmlUrl, 'https://example.com/');
	assert.match(payload.items[0].summary.content, /<p>Hello from a stored item\.<\/p>/);
	assert.equal(payload.items[0].summary.content, payload.items[0].content.content);
});

test('stream/items/contents includes every label category for a tagged feed', async () => {
	const form = new FormData();
	form.append('i', '1');

	const response = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/stream/items/contents', {
			method: 'POST',
			headers: {
				Authorization: await generateAuthHeader('secret-password'),
			},
			body: form,
		}),
		createReaderApiEnv(
			[{ ...ITEM_ROW }],
			[
				{
					...FEED_ROW,
					rowid: 7,
					feed_key: FEED_ROW.feed_key,
					category: 'Daily Reads',
					tags: ['Daily Reads', 'Favorites'],
				},
			],
		) as never,
	);

	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.deepEqual(payload.items[0].categories, [
		'user/-/state/com.google/reading-list',
		'user/-/label/Daily Reads',
		'user/-/label/Favorites',
	]);
});

test('edit-tag batches large read-state updates so NetNewsWire sync writes stay within D1 limits', async () => {
	const cases = [
		{
			param: 'a',
			tag: 'user/-/state/com.google/read',
			expectedSql: 'UPDATE items SET is_read = 1',
			toItemId: (rowid: number) => String(rowid),
		},
		{
			param: 'r',
			tag: 'user/-/state/com.google/read',
			expectedSql: 'UPDATE items SET is_read = 0',
			toItemId: (rowid: number) => `tag:google.com,2005:reader/item/${rowid.toString(16).padStart(16, '0')}`,
		},
		{
			param: 'a',
			tag: 'user/-/state/com.google/starred',
			expectedSql: 'UPDATE items SET is_starred = 1',
			toItemId: (rowid: number) => String(rowid),
		},
		{
			param: 'r',
			tag: 'user/-/state/com.google/starred',
			expectedSql: 'UPDATE items SET is_starred = 0',
			toItemId: (rowid: number) => `tag:google.com,2005:reader/item/${rowid.toString(16).padStart(16, '0')}`,
		},
	];

	for (const testCase of cases) {
		const form = new URLSearchParams();
		for (let rowid = 1; rowid <= 250; rowid += 1) {
			form.append('i', testCase.toItemId(rowid));
		}
		form.set(testCase.param, testCase.tag);

		const { env, batches } = createEditTagEnv();
		const response = await handleGreaderRequest(
			new Request('https://pigeon.example/reader/api/0/edit-tag', {
				method: 'POST',
				headers: {
					Authorization: await generateAuthHeader('secret-password'),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: form,
			}),
			env as never,
		);

		assert.equal(response.status, 200);
		assert.equal(await response.text(), 'OK');
		assert.equal(batches.length, 3);
		assert.deepEqual(
			batches.map((batch) => batch.values.length),
			[100, 100, 50],
		);
		assert.ok(batches.every((batch) => batch.sql.includes(testCase.expectedSql)));
		assert.deepEqual(
			batches.flatMap((batch) => batch.values).map((value) => Number(value)),
			Array.from({ length: 250 }, (_, index) => index + 1),
		);
	}
});

test('stream/items/contents batches large item lookups so desktop readers do not hit D1 parameter limits', async () => {
	const form = new URLSearchParams();
	for (let rowid = 1; rowid <= 125; rowid += 1) {
		form.append('i', String(rowid));
	}

	const response = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/stream/items/contents', {
			method: 'POST',
			headers: {
				Authorization: await generateAuthHeader('secret-password'),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: form,
		}),
		createLargeBatchEnv(125) as never,
	);

	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.equal(payload.items.length, 125);
	assert.equal(payload.items[0].id, 'tag:google.com,2005:reader/item/0000000000000001');
	assert.equal(payload.items[124].id, 'tag:google.com,2005:reader/item/000000000000007d');
});

test('stream/items/ids orders by received time before rowid', async () => {
	const items = [
		{ ...ITEM_ROW, rowid: 1, feed_key: 'feed-1', received_at: '2026-03-20T12:00:03.000Z' },
		{ ...ITEM_ROW, rowid: 2, feed_key: 'feed-2', received_at: '2026-03-20T12:00:02.000Z' },
		{ ...ITEM_ROW, rowid: 3, feed_key: 'feed-3', received_at: '2026-03-20T12:00:01.000Z' },
		{ ...ITEM_ROW, rowid: 4, feed_key: 'feed-4', received_at: '2026-03-20T12:00:02.000Z' },
	];
	const feeds = items.map((item) => ({
		...FEED_ROW,
		rowid: item.rowid,
		feed_key: item.feed_key,
	}));
	const response = await handleGreaderRequest(
		new Request(
			'https://pigeon.example/reader/api/0/stream/items/ids?n=4&xt=user/-/state/com.google/read&output=json&s=user/-/state/com.google/reading-list',
			{
				headers: {
					Authorization: await generateAuthHeader('secret-password'),
				},
			},
		),
		createReaderApiEnv(items, feeds) as never,
	);

	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.deepEqual(payload.itemRefs.map((itemRef: { id: string }) => itemRef.id), ['1', '4', '2', '3']);
});

test('stream/items/ids paginates unread item references with continuation tokens', async () => {
	const authHeader = await generateAuthHeader('secret-password');
	const firstPage = await handleGreaderRequest(
		new Request(
			'https://pigeon.example/reader/api/0/stream/items/ids?n=1000&xt=user/-/state/com.google/read&output=json&s=user/-/state/com.google/reading-list',
			{
				headers: {
					Authorization: authHeader,
				},
			},
		),
		createPaginatedStreamEnv(1582) as never,
	);

	assert.equal(firstPage.status, 200);
	const firstPayload = await firstPage.json();
	assert.equal(firstPayload.itemRefs.length, 1000);
	assert.equal(firstPayload.itemRefs[0].id, '1582');
	assert.equal(firstPayload.itemRefs[999].id, '583');
	assert.equal(typeof firstPayload.continuation, 'string');

	const secondUrl = new URL('https://pigeon.example/reader/api/0/stream/items/ids');
	secondUrl.search = new URLSearchParams({
		n: '1000',
		xt: 'user/-/state/com.google/read',
		output: 'json',
		s: 'user/-/state/com.google/reading-list',
		c: firstPayload.continuation,
	}).toString();
	const secondPage = await handleGreaderRequest(
		new Request(secondUrl, {
			headers: {
				Authorization: authHeader,
			},
		}),
		createPaginatedStreamEnv(1582) as never,
	);

	assert.equal(secondPage.status, 200);
	const secondPayload = await secondPage.json();
	assert.equal(secondPayload.itemRefs.length, 582);
	assert.equal(secondPayload.itemRefs[0].id, '582');
	assert.equal(secondPayload.itemRefs[581].id, '1');
	assert.equal(secondPayload.continuation, undefined);
});

test('stream/contents paginates unread items with the shared continuation helper', async () => {
	const authHeader = await generateAuthHeader('secret-password');
	const firstPage = await handleGreaderRequest(
		new Request(
			'https://pigeon.example/reader/api/0/stream/contents/reading-list?n=1000&xt=user/-/state/com.google/read',
			{
				headers: {
					Authorization: authHeader,
				},
			},
		),
		createLargeBatchEnv(1582) as never,
	);

	assert.equal(firstPage.status, 200);
	const firstPayload = await firstPage.json();
	assert.equal(firstPayload.items.length, 1000);
	assert.equal(typeof firstPayload.continuation, 'string');

	const secondUrl = new URL('https://pigeon.example/reader/api/0/stream/contents/reading-list');
	secondUrl.search = new URLSearchParams({
		n: '1000',
		xt: 'user/-/state/com.google/read',
		c: firstPayload.continuation,
	}).toString();
	const secondPage = await handleGreaderRequest(
		new Request(secondUrl, {
			headers: {
				Authorization: authHeader,
			},
		}),
		createLargeBatchEnv(1582) as never,
	);

	assert.equal(secondPage.status, 200);
	const secondPayload = await secondPage.json();
	assert.equal(secondPayload.items.length, 582);
	assert.equal(secondPayload.continuation, undefined);
	assert.equal(new Set([...firstPayload.items, ...secondPayload.items].map((item: { id: string }) => item.id)).size, 1582);
});

test('stream/contents/reading-list returns full items in a FreshRSS-compatible envelope', async () => {
	const response = await handleGreaderRequest(
		new Request(
			'https://pigeon.example/reader/api/0/stream/contents/reading-list?n=20&xt=user/-/state/com.google/read',
			{
				headers: {
					Authorization: await generateAuthHeader('secret-password'),
				},
			},
		),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.equal(payload.id, 'user/-/state/com.google/reading-list');
	assert.equal(typeof payload.updated, 'number');
	assert.equal(payload.items.length, 1);
	assert.equal(payload.items[0].title, 'Styled newsletter');
});

test('stream/contents/feed/:id resolves feed-specific streams used by FreshRSS clients', async () => {
	const response = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/stream/contents/feed/7?n=20', {
			headers: {
				Authorization: await generateAuthHeader('secret-password'),
			},
		}),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.equal(payload.id, 'feed/7');
	assert.equal(payload.items.length, 1);
	assert.equal(payload.items[0].alternate[0].href, 'https://example.com/posts/styled-newsletter');
	assert.equal(payload.items[0].origin.streamId, 'feed/7');
});

test('stream/items/ids returns only items from feeds in the requested label stream', async () => {
	const env = createReaderApiEnv(
		[
			{
				...ITEM_ROW,
				rowid: 1,
				feed_key: 'alpha-feed',
				received_at: '2026-03-20T12:34:56.000Z',
			},
			{
				...ITEM_ROW,
				rowid: 2,
				feed_key: 'bravo-feed',
				received_at: '2026-03-20T12:30:00.000Z',
			},
		],
		[
			{
				...FEED_ROW,
				rowid: 7,
				feed_key: 'alpha-feed',
				category: 'Daily Reads',
			},
			{
				...FEED_ROW,
				rowid: 8,
				feed_key: 'bravo-feed',
				category: null,
			},
		],
	);

	const response = await handleGreaderRequest(
		new Request(
			'https://pigeon.example/reader/api/0/stream/items/ids?n=20&s=user/-/label/Daily%20Reads',
			{
				headers: {
					Authorization: await generateAuthHeader('secret-password'),
				},
			},
		),
		env as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		itemRefs: [{ id: '1' }],
	});
});

test('stream/items/ids includes feeds matched through multi-label feed tags', async () => {
	const env = createReaderApiEnv(
		[
			{
				...ITEM_ROW,
				rowid: 1,
				feed_key: 'alpha-feed',
				received_at: '2026-03-20T12:34:56.000Z',
			},
			{
				...ITEM_ROW,
				rowid: 2,
				feed_key: 'bravo-feed',
				received_at: '2026-03-20T12:30:00.000Z',
			},
		],
		[
			{
				...FEED_ROW,
				rowid: 7,
				feed_key: 'alpha-feed',
				category: null,
				tags: ['Favorites', 'Work'],
			},
			{
				...FEED_ROW,
				rowid: 8,
				feed_key: 'bravo-feed',
				category: null,
				tags: ['Work'],
			},
		],
	);

	const response = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/stream/items/ids?n=20&s=user/-/label/Favorites', {
			headers: {
				Authorization: await generateAuthHeader('secret-password'),
			},
		}),
		env as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		itemRefs: [{ id: '1' }],
	});
});

test('unread-count includes a reading-list total for clients that expect a global unread bucket', async () => {
	const newestItemTimestampUsec = String(new Date(ITEM_ROW.received_at).getTime() * 1000);
	const response = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/unread-count', {
			headers: {
				Authorization: await generateAuthHeader('secret-password'),
			},
		}),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.deepEqual(payload.unreadcounts, [
		{
			id: 'feed/7',
			count: 1,
			newestItemTimestampUsec,
		},
		{
			id: 'user/-/label/Newsletters',
			count: 1,
			newestItemTimestampUsec,
		},
		{
			id: 'user/-/state/com.google/reading-list',
			count: 1,
			newestItemTimestampUsec,
		},
	]);
});

test('unread-count exposes separate totals for every label attached to a feed', async () => {
	const newestItemTimestampUsec = String(new Date(ITEM_ROW.received_at).getTime() * 1000);
	const response = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/unread-count', {
			headers: {
				Authorization: await generateAuthHeader('secret-password'),
			},
		}),
		createReaderApiEnv(
			[{ ...ITEM_ROW, rowid: 1, feed_key: 'alpha-feed' }],
			[
				{
					...FEED_ROW,
					rowid: 7,
					feed_key: 'alpha-feed',
					category: 'Daily Reads',
					tags: ['Daily Reads', 'Favorites'],
				},
			],
		) as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual((await response.json()).unreadcounts, [
		{
			id: 'feed/7',
			count: 1,
			newestItemTimestampUsec,
		},
		{
			id: 'user/-/label/Daily Reads',
			count: 1,
			newestItemTimestampUsec,
		},
		{
			id: 'user/-/label/Favorites',
			count: 1,
			newestItemTimestampUsec,
		},
		{
			id: 'user/-/state/com.google/reading-list',
			count: 1,
			newestItemTimestampUsec,
		},
	]);
});

test('unread totals and reading-list streams exclude items from inactive feeds', async () => {
	const activeItem = {
		rowid: 1,
		feed_key: 'active-feed',
		received_at: '2026-03-20T13:00:00.000Z',
		is_read: 0,
	};
	const inactiveItem = {
		rowid: 2,
		feed_key: 'inactive-feed',
		received_at: '2026-03-20T14:00:00.000Z',
		is_read: 0,
	};
	const { env } = createSqliteMarkAllAsReadEnv(
		[activeItem, inactiveItem],
		[
			{
				rowid: 7,
				feed_key: 'active-feed',
				category: 'Daily Reads',
				is_active: 1,
			},
			{
				rowid: 8,
				feed_key: 'inactive-feed',
				category: 'Daily Reads',
				is_active: 0,
			},
		],
	);
	const headers = { Authorization: await generateAuthHeader('secret-password') };

	const unreadResponse = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/unread-count', { headers }),
		env as never,
	);
	assert.equal(unreadResponse.status, 200);
	const newestItemTimestampUsec = String(new Date(activeItem.received_at).getTime() * 1000);
	assert.deepEqual((await unreadResponse.json()).unreadcounts, [
		{
			id: 'feed/7',
			count: 1,
			newestItemTimestampUsec,
		},
		{
			id: 'user/-/label/Daily Reads',
			count: 1,
			newestItemTimestampUsec,
		},
		{
			id: 'user/-/state/com.google/reading-list',
			count: 1,
			newestItemTimestampUsec,
		},
	]);

	const idsResponse = await handleGreaderRequest(
		new Request(
			'https://pigeon.example/reader/api/0/stream/items/ids?n=20&xt=user/-/state/com.google/read&s=user/-/state/com.google/reading-list',
			{ headers },
		),
		env as never,
	);
	assert.deepEqual(await idsResponse.json(), { itemRefs: [{ id: '1' }] });

	const contentsResponse = await handleGreaderRequest(
		new Request(
			'https://pigeon.example/reader/api/0/stream/contents/reading-list?n=20&xt=user/-/state/com.google/read',
			{ headers },
		),
		env as never,
	);
	assert.deepEqual(
		(await contentsResponse.json()).items.map((item: { id: string }) => item.id),
		['tag:google.com,2005:reader/item/0000000000000001'],
	);

	const hiddenFeedResponse = await handleGreaderRequest(
		new Request('https://pigeon.example/reader/api/0/stream/items/ids?n=20&s=feed/8', { headers }),
		env as never,
	);
	assert.deepEqual(await hiddenFeedResponse.json(), { itemRefs: [] });
});

test('mark-all-as-read without ts marks every item in the requested feed', async () => {
	const { env, items } = createMarkAllAsReadEnv(
		[
			{ rowid: 1, feed_key: 'alpha-feed', received_at: '2026-03-20T12:00:00.000Z', is_read: 0 },
			{ rowid: 2, feed_key: 'alpha-feed', received_at: '2026-03-20T13:00:00.000Z', is_read: 0 },
			{ rowid: 3, feed_key: 'bravo-feed', received_at: '2026-03-20T14:00:00.000Z', is_read: 0 },
		],
		[
			{ rowid: 7, feed_key: 'alpha-feed', is_active: 1 },
			{ rowid: 8, feed_key: 'bravo-feed', is_active: 1 },
		],
	);

	const response = await markAllAsRead(env, { s: 'feed/7' });

	assert.equal(response.status, 200);
	assert.deepEqual(
		items.map((item) => item.is_read),
		[1, 1, 0],
	);
});

test('mark-all-as-read treats ts=0 as no cutoff for label streams and only affects active feeds', async () => {
	const { env, items } = createMarkAllAsReadEnv(
		[
			{ rowid: 1, feed_key: 'alpha-feed', received_at: '2026-03-20T12:00:00.000Z', is_read: 0 },
			{ rowid: 2, feed_key: 'bravo-feed', received_at: '2026-03-20T13:00:00.000Z', is_read: 0 },
			{ rowid: 3, feed_key: 'charlie-feed', received_at: '2026-03-20T14:00:00.000Z', is_read: 0 },
			{ rowid: 4, feed_key: 'delta-feed', received_at: '2026-03-20T15:00:00.000Z', is_read: 0 },
		],
		[
			{ rowid: 7, feed_key: 'alpha-feed', category: 'Daily Reads', is_active: 1 },
			{ rowid: 8, feed_key: 'bravo-feed', tags: ['Daily Reads'], is_active: 1 },
			{ rowid: 9, feed_key: 'charlie-feed', category: 'Daily Reads', is_active: 0 },
			{ rowid: 10, feed_key: 'delta-feed', is_active: 1 },
		],
	);

	const response = await markAllAsRead(env, {
		s: 'user/-/label/Daily Reads',
		ts: '0',
	});

	assert.equal(response.status, 200);
	assert.deepEqual(
		items.map((item) => item.is_read),
		[1, 1, 0, 0],
	);
});

test('mark-all-as-read respects second-based cutoffs for the reading list', async () => {
	const { env, items } = createMarkAllAsReadEnv(
		[
			{ rowid: 1, feed_key: 'alpha-feed', received_at: '2026-03-20T12:00:00.000Z', is_read: 0 },
			{ rowid: 2, feed_key: 'bravo-feed', received_at: '2026-03-20T12:30:00.000Z', is_read: 0 },
			{ rowid: 3, feed_key: 'charlie-feed', received_at: '2026-03-20T13:00:00.000Z', is_read: 0 },
		],
		[
			{ rowid: 7, feed_key: 'alpha-feed', is_active: 1 },
			{ rowid: 8, feed_key: 'bravo-feed', is_active: 1 },
			{ rowid: 9, feed_key: 'charlie-feed', is_active: 1 },
		],
	);
	const cutoffSeconds = Math.floor(new Date('2026-03-20T12:30:00.000Z').getTime() / 1000);

	const response = await markAllAsRead(env, {
		s: 'user/-/state/com.google/reading-list',
		ts: String(cutoffSeconds),
	});

	assert.equal(response.status, 200);
	assert.deepEqual(
		items.map((item) => item.is_read),
		[1, 1, 0],
	);
});

test('mark-all-as-read for the reading list preserves unread state in inactive feeds', async () => {
	const { env, items } = createMarkAllAsReadEnv(
		[
			{ rowid: 1, feed_key: 'active-feed', received_at: '2026-03-20T12:00:00.000Z', is_read: 0 },
			{ rowid: 2, feed_key: 'inactive-feed', received_at: '2026-03-20T12:30:00.000Z', is_read: 0 },
		],
		[
			{ rowid: 7, feed_key: 'active-feed', is_active: 1 },
			{ rowid: 8, feed_key: 'inactive-feed', is_active: 0 },
		],
	);

	const response = await markAllAsRead(env, {
		s: 'user/-/state/com.google/reading-list',
	});

	assert.equal(response.status, 200);
	assert.deepEqual(
		items.map((item) => item.is_read),
		[1, 0],
	);
});

test('mark-all-as-read for an inactive feed preserves unread state', async () => {
	const { db, env } = createSqliteMarkAllAsReadEnv(
		[
			{ rowid: 1, feed_key: 'active-feed', received_at: '2026-03-20T12:00:00.000Z', is_read: 0 },
			{ rowid: 2, feed_key: 'inactive-feed', received_at: '2026-03-20T12:30:00.000Z', is_read: 0 },
		],
		[
			{ rowid: 7, feed_key: 'active-feed', is_active: 1 },
			{ rowid: 8, feed_key: 'inactive-feed', is_active: 0 },
		],
	);

	const response = await markAllAsRead(env, { s: 'feed/8' });

	assert.equal(response.status, 200);
	assert.deepEqual(
		(db.prepare('SELECT rowid, is_read FROM items ORDER BY rowid').all() as Array<{ rowid: number; is_read: number }>).map(
			(row) => ({ rowid: row.rowid, is_read: row.is_read }),
		),
		[
			{ rowid: 1, is_read: 0 },
			{ rowid: 2, is_read: 0 },
		],
	);
});

test('mark-all-as-read rejects malformed timestamps instead of treating them as mark-all', async () => {
	for (const ts of ['-1', '123.4', 'not-a-timestamp']) {
		const { env, items } = createMarkAllAsReadEnv(
			[
				{ rowid: 1, feed_key: 'alpha-feed', received_at: '2026-03-20T12:00:00.000Z', is_read: 0 },
				{ rowid: 2, feed_key: 'alpha-feed', received_at: '2026-03-20T13:00:00.000Z', is_read: 0 },
			],
			[{ rowid: 7, feed_key: 'alpha-feed', is_active: 1 }],
		);

		const response = await markAllAsRead(env, {
			s: 'feed/7',
			ts,
		});

		assert.equal(response.status, 400);
		assert.equal(await response.text(), 'Invalid timestamp');
		assert.deepEqual(
			items.map((item) => item.is_read),
			[0, 0],
		);
	}
});

test('mark-all-as-read treats equivalent second, millisecond, microsecond, and nanosecond cutoffs the same for feed streams', async () => {
	const cutoffSeconds = Math.floor(new Date('2026-03-20T12:30:00.000Z').getTime() / 1000);
	const timestamps = [
		String(cutoffSeconds),
		(cutoffSeconds * 1_000).toString(),
		(BigInt(cutoffSeconds) * 1_000_000n).toString(),
		(BigInt(cutoffSeconds) * 1_000_000_000n).toString(),
	];

	for (const ts of timestamps) {
		const { env, items } = createMarkAllAsReadEnv(
			[
				{ rowid: 1, feed_key: 'alpha-feed', received_at: '2026-03-20T12:00:00.000Z', is_read: 0 },
				{ rowid: 2, feed_key: 'alpha-feed', received_at: '2026-03-20T12:30:00.000Z', is_read: 0 },
				{ rowid: 3, feed_key: 'alpha-feed', received_at: '2026-03-20T13:00:00.000Z', is_read: 0 },
			],
			[{ rowid: 7, feed_key: 'alpha-feed', is_active: 1 }],
		);

		const response = await markAllAsRead(env, {
			s: 'feed/7',
			ts,
		});

		assert.equal(response.status, 200);
		assert.deepEqual(
			items.map((item) => item.is_read),
			[1, 1, 0],
		);
	}
});

test('mark-all-as-read uses SQLite datetime semantics so ISO timestamps respect cutoffs', async () => {
	const { db, env } = createSqliteMarkAllAsReadEnv(
		[
			{ rowid: 1, feed_key: 'alpha-feed', received_at: '2026-03-20T12:00:00.000Z', is_read: 0 },
			{ rowid: 2, feed_key: 'alpha-feed', received_at: '2026-03-20T12:30:00.000Z', is_read: 0 },
			{ rowid: 3, feed_key: 'alpha-feed', received_at: '2026-03-20T13:00:00.000Z', is_read: 0 },
		],
		[{ rowid: 7, feed_key: 'alpha-feed', is_active: 1 }],
	);
	const cutoffSeconds = Math.floor(new Date('2026-03-20T12:30:00.000Z').getTime() / 1000);

	const rawPredicateMatches = db
		.prepare("SELECT rowid FROM items WHERE received_at <= datetime(?, 'unixepoch') ORDER BY rowid")
		.all(cutoffSeconds) as Array<{ rowid: number }>;
	assert.deepEqual(rawPredicateMatches, []);

	const response = await markAllAsRead(env, {
		s: 'user/-/state/com.google/reading-list',
		ts: String(cutoffSeconds),
	});

	assert.equal(response.status, 200);
	assert.deepEqual(
		(
			db.prepare('SELECT rowid, is_read FROM items ORDER BY rowid').all() as Array<{
				rowid: number;
				is_read: number;
			}>
		).map((row) => ({ rowid: row.rowid, is_read: row.is_read })),
		[
			{ rowid: 1, is_read: 1 },
			{ rowid: 2, is_read: 1 },
			{ rowid: 3, is_read: 0 },
		],
	);
});
