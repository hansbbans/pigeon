import type { Env } from './types';

const REQUIRED_SCHEMA_VERSION = '8';

const migrationPromises = new WeakMap<D1Database, Promise<void>>();

interface TableInfoRow {
	name: string;
}

function isDuplicateColumnError(error: unknown, columnName: string): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('duplicate column name') && message.includes(columnName);
}

export async function ensureDatabaseSchema(env: Env): Promise<void> {
	const existing = migrationPromises.get(env.DB);
	if (existing) {
		return existing;
	}

	const migration = runDatabaseMigrations(env.DB).catch((error) => {
		migrationPromises.delete(env.DB);
		throw error;
	});
	migrationPromises.set(env.DB, migration);
	return migration;
}

async function runDatabaseMigrations(db: D1Database): Promise<void> {
	await db.prepare('CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)').run();
	await db.prepare("INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '0')").run();

	const feedColumns = await getTableColumns(db, 'feeds');
	if (feedColumns.size === 0) {
		throw new Error(
			'Cannot migrate Pigeon database: missing feeds table. Initialize the database with 04-storage/SCHEMA.sql first.',
		);
	}

	await addColumnIfMissing(db, feedColumns, 'feeds', "source_type TEXT NOT NULL DEFAULT 'email'");
	await addColumnIfMissing(db, feedColumns, 'feeds', 'source_url TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'fetch_interval_minutes INTEGER DEFAULT 60');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'last_fetched_at TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'fetch_error TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'etag TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'last_modified TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'icon_url TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'site_url TEXT');

	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS idx_feeds_next_fetch
			  ON feeds(source_type, last_fetched_at)
			  WHERE source_type = 'rss' AND is_active = 1`,
		)
		.run();

	const itemColumns = await getTableColumns(db, 'items');
	if (itemColumns.size === 0) {
		throw new Error(
			'Cannot migrate Pigeon database: missing items table. Initialize the database with 04-storage/SCHEMA.sql first.',
		);
	}
	await addColumnIfMissing(db, itemColumns, 'items', 'original_url TEXT');

	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS feed_tags (
			  feed_key TEXT NOT NULL,
			  label TEXT NOT NULL,
			  created_at TEXT NOT NULL DEFAULT (datetime('now')),
			  PRIMARY KEY (feed_key, label),
			  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key)
			)`,
		)
		.run();
	await db.prepare('CREATE INDEX IF NOT EXISTS idx_feed_tags_label ON feed_tags(label, feed_key)').run();

	if (feedColumns.has('category')) {
		await db
			.prepare(
				`INSERT OR IGNORE INTO feed_tags (feed_key, label)
				 SELECT feed_key, category
				   FROM feeds
				  WHERE category IS NOT NULL AND category <> ''`,
			)
			.run();
	}

	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS engagement_events (
			  id TEXT PRIMARY KEY,
			  event_key TEXT NOT NULL UNIQUE,
			  item_id TEXT,
			  feed_key TEXT,
			  event_type TEXT NOT NULL,
			  client_family TEXT NOT NULL DEFAULT 'other',
			  value REAL,
			  duration_seconds REAL,
			  scroll_depth REAL,
			  destination_host TEXT,
			  occurred_at TEXT NOT NULL,
			  created_at TEXT NOT NULL DEFAULT (datetime('now')),
			  metadata_json TEXT,
			  FOREIGN KEY (item_id) REFERENCES items(id),
			  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key),
			  CHECK (event_type IN (
			    'explicit_open', 'active_reading', 'scroll_depth', 'outbound_link',
			    'star', 'unstar', 'more_like_this', 'not_interested',
			    'read', 'unread', 'bulk_mark_all_read'
			  )),
			  CHECK (client_family IN ('pigeon', 'reeder_classic', 'netnewswire', 'other')),
			  CHECK (scroll_depth IS NULL OR (scroll_depth >= 0 AND scroll_depth <= 1)),
			  CHECK (duration_seconds IS NULL OR (duration_seconds >= 0 AND duration_seconds <= 86400))
			)`,
		)
		.run();
	try {
		await db.prepare('ALTER TABLE engagement_events ADD COLUMN destination_host TEXT').run();
	} catch (error) {
		if (!isDuplicateColumnError(error, 'destination_host')) {
			throw error;
		}
	}
	await db.prepare('CREATE INDEX IF NOT EXISTS idx_engagement_events_feed ON engagement_events(feed_key, event_type, occurred_at DESC)').run();
	await db.prepare('CREATE INDEX IF NOT EXISTS idx_engagement_events_item ON engagement_events(item_id, event_type, occurred_at DESC)').run();
	await db.prepare('CREATE INDEX IF NOT EXISTS idx_engagement_events_occurred ON engagement_events(occurred_at DESC)').run();

	await db.prepare("UPDATE _meta SET value = ? WHERE key = 'schema_version'").bind(REQUIRED_SCHEMA_VERSION).run();
}

async function getTableColumns(db: D1Database, tableName: 'feeds' | 'items'): Promise<Set<string>> {
	const { results } = await db.prepare(`PRAGMA table_info(${tableName})`).all<TableInfoRow>();
	return new Set(results.map((row) => row.name));
}

async function addColumnIfMissing(
	db: D1Database,
	columns: Set<string>,
	tableName: 'feeds' | 'items',
	columnDefinition: string,
): Promise<void> {
	const columnName = columnDefinition.split(/\s+/, 1)[0];
	if (columns.has(columnName)) {
		return;
	}

	try {
		await db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`).run();
	} catch (error) {
		if (!isDuplicateColumnError(error, columnName)) {
			throw error;
		}
	}
	columns.add(columnName);
}
