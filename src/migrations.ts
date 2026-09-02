import type { Env } from './types';

const REQUIRED_SCHEMA_VERSION = '12';
const REQUIRED_SCHEMA_VERSION_NUMBER = Number(REQUIRED_SCHEMA_VERSION);

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

	const schemaVersionRow = await db
		.prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
		.first<{ value: string | null }>();
	const persistedVersionValue = schemaVersionRow?.value;
	const persistedVersion = parsePersistedSchemaVersion(persistedVersionValue);
	if (persistedVersion > REQUIRED_SCHEMA_VERSION_NUMBER) {
		throw new Error(
			`Cannot migrate Pigeon database: unsupported newer schema version ${persistedVersionValue}; this Worker supports schema version ${REQUIRED_SCHEMA_VERSION}.`,
		);
	}
	if (persistedVersion === REQUIRED_SCHEMA_VERSION_NUMBER) {
		return;
	}

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
	await addColumnIfMissing(db, feedColumns, 'feeds', 'stale_archived INTEGER NOT NULL DEFAULT 0');

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

	// The sync log comes last: its triggers depend on the v6-v9 tables above,
	// and its one-time seed must see every existing status row.
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS sync_changes (
			  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			  entity_type TEXT NOT NULL,
			  entity_id TEXT NOT NULL,
			  operation TEXT NOT NULL DEFAULT 'upsert',
			  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
			  CHECK (entity_type IN ('feed', 'article', 'status')),
			  CHECK (operation IN ('upsert', 'delete'))
			)`,
		)
		.run();
	await db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_sequence ON sync_changes(sequence)').run();
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS mutation_receipts (
			  account_id TEXT NOT NULL DEFAULT 'default',
			  mutation_id TEXT NOT NULL,
			  mutation_kind TEXT NOT NULL,
			  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
			  result_json TEXT NOT NULL,
			  PRIMARY KEY (account_id, mutation_id)
			)`,
		)
		.run();
	await db
		.prepare('CREATE INDEX IF NOT EXISTS idx_mutation_receipts_applied ON mutation_receipts(account_id, applied_at DESC)')
		.run();

	for (const trigger of syncTriggers()) {
		await db.prepare(trigger).run();
	}

	// D1 executes batch statements sequentially and atomically. The private
	// claim is visible only inside this transaction, so a concurrent wrapper
	// that observed the same old version cannot run any source backfill after
	// this batch commits.
	const schemaVersionClaim = `__pigeon_schema_v${REQUIRED_SCHEMA_VERSION}_claim_${crypto.randomUUID()}`;
	const migrationBatch = [
		db.prepare('CREATE INDEX IF NOT EXISTS idx_sync_changes_entity ON sync_changes(entity_type, entity_id)'),
		db
			.prepare(
				"UPDATE _meta SET value = ? WHERE key = 'schema_version' AND value = ?",
			)
			.bind(schemaVersionClaim, persistedVersionValue),
		db
			.prepare(
				`INSERT OR IGNORE INTO item_statuses (account_id, item_id, is_read, is_starred, updated_at)
				 SELECT 'default', i.id, COALESCE(i.is_read, 0), COALESCE(i.is_starred, 0), COALESCE(i.created_at, datetime('now'))
				 FROM (SELECT 1 FROM _meta m
				        WHERE m.key = 'schema_version' AND m.value = ?) claim
				 CROSS JOIN items i
				 WHERE i.id IS NOT NULL`,
			)
			.bind(schemaVersionClaim),
		...(feedColumns.has('category')
			? [
					db
						.prepare(
							`INSERT OR IGNORE INTO feed_tags (feed_key, label)
							 SELECT f.feed_key, f.category
							 FROM (SELECT 1 FROM _meta m
							        WHERE m.key = 'schema_version' AND m.value = ?) claim
							 CROSS JOIN feeds f
							 WHERE f.category IS NOT NULL AND f.category <> ''`,
						)
						.bind(schemaVersionClaim),
			  ]
			: []),
		db
			.prepare(
				`INSERT INTO sync_changes (entity_type, entity_id)
				 SELECT 'feed', f.feed_key
				 FROM (SELECT 1 FROM _meta m
				        WHERE m.key = 'schema_version' AND m.value = ?) claim
				 CROSS JOIN feeds f
				 WHERE NOT EXISTS (
				   SELECT 1 FROM sync_changes c
				    WHERE c.entity_type = 'feed' AND c.entity_id = f.feed_key
				 )`,
			)
			.bind(schemaVersionClaim),
		db
			.prepare(
				`INSERT INTO sync_changes (entity_type, entity_id)
				 SELECT 'article', i.id
				 FROM (SELECT 1 FROM _meta m
				        WHERE m.key = 'schema_version' AND m.value = ?) claim
				 CROSS JOIN items i
				 WHERE i.id IS NOT NULL
				   AND NOT EXISTS (
				     SELECT 1 FROM sync_changes c
				      WHERE c.entity_type = 'article' AND c.entity_id = i.id
				   )`,
			)
			.bind(schemaVersionClaim),
		db
			.prepare(
				`INSERT INTO sync_changes (entity_type, entity_id)
				 SELECT 'status', s.item_id
				 FROM (SELECT 1 FROM _meta m
				        WHERE m.key = 'schema_version' AND m.value = ?) claim
				 CROSS JOIN item_statuses s
				 WHERE s.account_id = 'default'
				   AND NOT EXISTS (
				     SELECT 1 FROM sync_changes c
				      WHERE c.entity_type = 'status' AND c.entity_id = s.item_id
				   )`,
			)
			.bind(schemaVersionClaim),
		db
			.prepare(
				"UPDATE _meta SET value = ? WHERE key = 'schema_version' AND value = ?",
			)
			.bind(REQUIRED_SCHEMA_VERSION, schemaVersionClaim),
	];
	await db.batch(migrationBatch);
}

function parsePersistedSchemaVersion(value: unknown): number {
	if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
		throw new Error(`Cannot migrate Pigeon database: malformed schema version ${String(value)}`);
	}

	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(`Cannot migrate Pigeon database: schema version is out of range (${value})`);
	}
	return parsed;
}

function syncTriggers(): string[] {
	return [
		`CREATE TRIGGER IF NOT EXISTS trg_sync_feed_insert AFTER INSERT ON feeds BEGIN
		   INSERT INTO sync_changes (entity_type, entity_id) VALUES ('feed', NEW.feed_key);
		 END`,
		`CREATE TRIGGER IF NOT EXISTS trg_sync_feed_update
		 AFTER UPDATE OF display_name, custom_title, source_url, site_url, icon_url, is_active ON feeds BEGIN
		   INSERT INTO sync_changes (entity_type, entity_id) VALUES ('feed', NEW.feed_key);
		 END`,
		`CREATE TRIGGER IF NOT EXISTS trg_sync_feed_delete AFTER DELETE ON feeds BEGIN
		   INSERT INTO sync_changes (entity_type, entity_id, operation) VALUES ('feed', OLD.feed_key, 'delete');
		 END`,
		`CREATE TRIGGER IF NOT EXISTS trg_sync_feed_tag_insert AFTER INSERT ON feed_tags BEGIN
		   INSERT INTO sync_changes (entity_type, entity_id) VALUES ('feed', NEW.feed_key);
		 END`,
		`CREATE TRIGGER IF NOT EXISTS trg_sync_feed_tag_delete AFTER DELETE ON feed_tags BEGIN
		   INSERT INTO sync_changes (entity_type, entity_id) VALUES ('feed', OLD.feed_key);
		 END`,
		`CREATE TRIGGER IF NOT EXISTS trg_sync_article_insert AFTER INSERT ON items BEGIN
		   INSERT INTO sync_changes (entity_type, entity_id) VALUES ('article', NEW.id);
		 END`,
		`CREATE TRIGGER IF NOT EXISTS trg_sync_article_update
		 AFTER UPDATE OF feed_key, subject, from_name, html_content, text_content, original_url, received_at, content_pruned_at ON items BEGIN
		   INSERT INTO sync_changes (entity_type, entity_id) VALUES ('article', NEW.id);
		 END`,
		`CREATE TRIGGER IF NOT EXISTS trg_sync_article_delete AFTER DELETE ON items BEGIN
		   INSERT INTO sync_changes (entity_type, entity_id, operation) VALUES ('article', OLD.id, 'delete');
		 END`,
		`CREATE TRIGGER IF NOT EXISTS trg_sync_status_insert AFTER INSERT ON item_statuses BEGIN
		   INSERT INTO sync_changes (entity_type, entity_id) VALUES ('status', NEW.item_id);
		 END`,
		`CREATE TRIGGER IF NOT EXISTS trg_sync_status_update
		 AFTER UPDATE OF is_read, is_starred, version, mutation_id ON item_statuses BEGIN
		   INSERT INTO sync_changes (entity_type, entity_id) VALUES ('status', NEW.item_id);
		 END`,
	];
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
