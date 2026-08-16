import type { Env } from './types';

const REQUIRED_SCHEMA_VERSION = '9';

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
	await addColumnIfMissing(db, feedColumns, 'feeds', 'canonical_url TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'feed_format TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'next_fetch_at TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'last_attempt_at TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'last_success_at TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'consecutive_failures INTEGER NOT NULL DEFAULT 0');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'last_http_status INTEGER');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'retry_after_at TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'content_hash TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'conditional_checked_at TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'refresh_lease_until TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'refresh_lease_token TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'last_refresh_outcome TEXT');
	await addColumnIfMissing(db, feedColumns, 'feeds', 'last_fetch_duration_ms INTEGER');

	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS idx_feeds_next_fetch
			  ON feeds(source_type, last_fetched_at)
			  WHERE source_type = 'rss' AND is_active = 1`,
		)
		.run();
	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS idx_feeds_refresh_due
			  ON feeds(next_fetch_at, last_attempt_at)
			  WHERE source_type = 'rss' AND is_active = 1`,
		)
		.run();
	await db
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_canonical_url
			  ON feeds(canonical_url)
			  WHERE canonical_url IS NOT NULL`,
		)
		.run();

	const itemColumns = await getTableColumns(db, 'items');
	if (itemColumns.size === 0) {
		throw new Error(
			'Cannot migrate Pigeon database: missing items table. Initialize the database with 04-storage/SCHEMA.sql first.',
		);
	}
	await addColumnIfMissing(db, itemColumns, 'items', 'original_url TEXT');
	await addColumnIfMissing(db, itemColumns, 'items', 'content_pruned_at TEXT');

	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS feed_url_aliases (
			  alias_url TEXT PRIMARY KEY,
			  feed_key TEXT NOT NULL,
			  canonical_url TEXT NOT NULL,
			  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
			  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key) ON DELETE CASCADE
			)`,
		)
		.run();
	await db
		.prepare('CREATE INDEX IF NOT EXISTS idx_feed_url_aliases_feed ON feed_url_aliases(feed_key)')
		.run();

	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS refresh_activity (
			  id TEXT PRIMARY KEY,
			  feed_key TEXT NOT NULL,
			  attempted_at TEXT NOT NULL,
			  completed_at TEXT NOT NULL,
			  outcome TEXT NOT NULL,
			  http_status INTEGER,
			  duration_ms INTEGER NOT NULL,
			  items_added INTEGER NOT NULL DEFAULT 0,
			  response_bytes INTEGER,
			  error_code TEXT,
			  error_message TEXT,
			  retry_at TEXT,
			  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key) ON DELETE CASCADE,
			  CHECK (outcome IN ('success', 'not_modified', 'unchanged', 'rate_limited', 'http_error', 'parse_error', 'network_error', 'rejected', 'lease_lost'))
			)`,
		)
		.run();
	await db
		.prepare('CREATE INDEX IF NOT EXISTS idx_refresh_activity_feed ON refresh_activity(feed_key, attempted_at DESC)')
		.run();
	await db
		.prepare('CREATE INDEX IF NOT EXISTS idx_refresh_activity_attempted ON refresh_activity(attempted_at DESC)')
		.run();

	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS item_statuses (
			  account_id TEXT NOT NULL DEFAULT 'default',
			  item_id TEXT NOT NULL,
			  is_read INTEGER NOT NULL DEFAULT 0,
			  is_starred INTEGER NOT NULL DEFAULT 0,
			  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			  version INTEGER NOT NULL DEFAULT 1,
			  mutation_id TEXT,
			  PRIMARY KEY (account_id, item_id),
			  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
			  CHECK (is_read IN (0, 1)),
			  CHECK (is_starred IN (0, 1))
			)`,
		)
		.run();
	await db
		.prepare('CREATE INDEX IF NOT EXISTS idx_item_statuses_sync ON item_statuses(account_id, version, item_id)')
		.run();
	await db
		.prepare(
			`INSERT OR IGNORE INTO item_statuses (account_id, item_id, is_read, is_starred, updated_at)
			 SELECT 'default', id, COALESCE(is_read, 0), COALESCE(is_starred, 0), COALESCE(created_at, datetime('now'))
			 FROM items
			 WHERE id IS NOT NULL`,
		)
		.run();
	await db
		.prepare(
			`CREATE TRIGGER IF NOT EXISTS trg_items_insert_status
			 AFTER INSERT ON items
			 WHEN NEW.id IS NOT NULL
			 BEGIN
			   INSERT OR IGNORE INTO item_statuses (account_id, item_id, is_read, is_starred, updated_at)
			   VALUES ('default', NEW.id, COALESCE(NEW.is_read, 0), COALESCE(NEW.is_starred, 0), datetime('now'));
			 END`,
		)
		.run();
	await db
		.prepare(
			`CREATE TRIGGER IF NOT EXISTS trg_items_update_status
			 AFTER UPDATE OF is_read, is_starred ON items
			 WHEN COALESCE(OLD.is_read, 0) <> COALESCE(NEW.is_read, 0)
			   OR COALESCE(OLD.is_starred, 0) <> COALESCE(NEW.is_starred, 0)
			 BEGIN
			   INSERT INTO item_statuses (account_id, item_id, is_read, is_starred, updated_at, version)
			   VALUES ('default', NEW.id, COALESCE(NEW.is_read, 0), COALESCE(NEW.is_starred, 0), datetime('now'), 1)
			   ON CONFLICT(account_id, item_id) DO UPDATE SET
			     is_read = excluded.is_read,
			     is_starred = excluded.is_starred,
			     updated_at = excluded.updated_at,
			     version = item_statuses.version + 1;
			 END`,
		)
		.run();

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
