-- Pigeon: Newsletter-to-RSS
-- D1 Schema v12

-- Schema version tracking
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '12');

-- Feeds metadata
CREATE TABLE IF NOT EXISTS feeds (
  feed_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  from_email TEXT,
  source_type TEXT NOT NULL DEFAULT 'email',
  source_url TEXT,
  site_url TEXT,
  fetch_interval_minutes INTEGER DEFAULT 60,
  last_fetched_at TEXT,
  fetch_error TEXT,
  etag TEXT,
  last_modified TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_item_at TEXT,
  item_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  stale_archived INTEGER NOT NULL DEFAULT 0,
  custom_title TEXT,
  category TEXT,
  icon_url TEXT,
  canonical_url TEXT,
  feed_format TEXT,
  next_fetch_at TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_http_status INTEGER,
  retry_after_at TEXT,
  content_hash TEXT,
  conditional_checked_at TEXT,
  refresh_lease_until TEXT,
  refresh_lease_token TEXT,
  last_refresh_outcome TEXT,
  last_fetch_duration_ms INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_canonical_url
  ON feeds(canonical_url)
  WHERE canonical_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS feed_url_aliases (
  alias_url TEXT PRIMARY KEY,
  feed_key TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feed_url_aliases_feed ON feed_url_aliases(feed_key);

CREATE TABLE IF NOT EXISTS feed_tags (
  feed_key TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (feed_key, label),
  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key)
);

CREATE INDEX IF NOT EXISTS idx_feed_tags_label ON feed_tags(label, feed_key);

-- Newsletter items
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  feed_key TEXT NOT NULL,
  from_name TEXT,
  from_email TEXT,
  subject TEXT NOT NULL,
  html_content TEXT NOT NULL,
  text_content TEXT,
  original_url TEXT,
  message_id TEXT UNIQUE,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  content_size INTEGER,
  content_pruned_at TEXT,
  is_read INTEGER DEFAULT 0,
  is_starred INTEGER DEFAULT 0,
  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key)
);

CREATE INDEX IF NOT EXISTS idx_items_feed_key_date ON items(feed_key, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_received_at ON items(received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_message_id ON items(message_id);
CREATE INDEX IF NOT EXISTS idx_items_unread ON items(is_read, feed_key);
CREATE INDEX IF NOT EXISTS idx_feeds_next_fetch
  ON feeds(source_type, last_fetched_at)
  WHERE source_type = 'rss' AND is_active = 1;
CREATE INDEX IF NOT EXISTS idx_feeds_refresh_due
  ON feeds(next_fetch_at, last_attempt_at)
  WHERE source_type = 'rss' AND is_active = 1;

CREATE TABLE IF NOT EXISTS item_statuses (
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
);

CREATE INDEX IF NOT EXISTS idx_item_statuses_sync
  ON item_statuses(account_id, version, item_id);

CREATE TRIGGER IF NOT EXISTS trg_items_insert_status
AFTER INSERT ON items
WHEN NEW.id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO item_statuses (account_id, item_id, is_read, is_starred, updated_at)
  VALUES ('default', NEW.id, COALESCE(NEW.is_read, 0), COALESCE(NEW.is_starred, 0), datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS trg_items_update_status
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
END;

CREATE TABLE IF NOT EXISTS refresh_activity (
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
  CHECK (outcome IN (
    'success', 'not_modified', 'unchanged', 'rate_limited', 'http_error',
    'parse_error', 'network_error', 'rejected', 'lease_lost'
  ))
);

CREATE INDEX IF NOT EXISTS idx_refresh_activity_feed
  ON refresh_activity(feed_key, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_refresh_activity_attempted
  ON refresh_activity(attempted_at DESC);

-- Ordered change log for bounded, cursor-based native synchronization.
CREATE TABLE IF NOT EXISTS sync_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'upsert',
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (entity_type IN ('feed', 'article', 'status')),
  CHECK (operation IN ('upsert', 'delete'))
);

CREATE INDEX IF NOT EXISTS idx_sync_changes_sequence ON sync_changes(sequence);
CREATE INDEX IF NOT EXISTS idx_sync_changes_entity
  ON sync_changes(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS mutation_receipts (
  account_id TEXT NOT NULL DEFAULT 'default',
  mutation_id TEXT NOT NULL,
  mutation_kind TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  result_json TEXT NOT NULL,
  PRIMARY KEY (account_id, mutation_id)
);

CREATE INDEX IF NOT EXISTS idx_mutation_receipts_applied
  ON mutation_receipts(account_id, applied_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_sync_feed_insert
AFTER INSERT ON feeds
BEGIN
  INSERT INTO sync_changes (entity_type, entity_id) VALUES ('feed', NEW.feed_key);
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_feed_update
AFTER UPDATE OF display_name, custom_title, source_url, site_url, icon_url, is_active ON feeds
BEGIN
  INSERT INTO sync_changes (entity_type, entity_id) VALUES ('feed', NEW.feed_key);
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_feed_delete
AFTER DELETE ON feeds
BEGIN
  INSERT INTO sync_changes (entity_type, entity_id, operation) VALUES ('feed', OLD.feed_key, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_feed_tag_insert
AFTER INSERT ON feed_tags
BEGIN
  INSERT INTO sync_changes (entity_type, entity_id) VALUES ('feed', NEW.feed_key);
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_feed_tag_delete
AFTER DELETE ON feed_tags
BEGIN
  INSERT INTO sync_changes (entity_type, entity_id) VALUES ('feed', OLD.feed_key);
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_article_insert
AFTER INSERT ON items
BEGIN
  INSERT INTO sync_changes (entity_type, entity_id) VALUES ('article', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_article_update
AFTER UPDATE OF feed_key, subject, from_name, html_content, text_content, original_url, received_at, content_pruned_at ON items
BEGIN
  INSERT INTO sync_changes (entity_type, entity_id) VALUES ('article', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_article_delete
AFTER DELETE ON items
BEGIN
  INSERT INTO sync_changes (entity_type, entity_id, operation) VALUES ('article', OLD.id, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_status_insert
AFTER INSERT ON item_statuses
BEGIN
  INSERT INTO sync_changes (entity_type, entity_id) VALUES ('status', NEW.item_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_status_update
AFTER UPDATE OF is_read, is_starred, version, mutation_id ON item_statuses
BEGIN
  INSERT INTO sync_changes (entity_type, entity_id) VALUES ('status', NEW.item_id);
END;

-- Custom parsing rules (Phase 4)
CREATE TABLE IF NOT EXISTS parsing_rules (
  id TEXT PRIMARY KEY,
  feed_key TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  rule_config TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key)
);

CREATE INDEX IF NOT EXISTS idx_rules_feed_key ON parsing_rules(feed_key, priority DESC);

-- Append-only behavior signals used by Pigeon recommendations.
CREATE TABLE IF NOT EXISTS engagement_events (
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
);

CREATE INDEX IF NOT EXISTS idx_engagement_events_feed
  ON engagement_events(feed_key, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_engagement_events_item
  ON engagement_events(item_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_engagement_events_occurred
  ON engagement_events(occurred_at DESC);

-- Routing rules: override feed key based on subject/sender patterns
CREATE TABLE IF NOT EXISTS routing_rules (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_feed_key TEXT NOT NULL,
  match_field TEXT NOT NULL DEFAULT 'subject',    -- 'subject', 'from_name', 'from_email'
  match_type TEXT NOT NULL DEFAULT 'contains',    -- 'contains', 'starts_with', 'ends_with', 'regex'
  match_pattern TEXT NOT NULL,
  target_feed_key TEXT NOT NULL,
  target_display_name TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (match_field IN ('subject', 'from_name', 'from_email')),
  CHECK (match_type IN ('contains', 'starts_with', 'ends_with', 'regex'))
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_source ON routing_rules(source_feed_key, is_active, priority DESC);
