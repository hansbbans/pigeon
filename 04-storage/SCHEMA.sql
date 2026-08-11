-- Pigeon: Newsletter-to-RSS
-- D1 Schema v8

-- Schema version tracking
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '8');

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
  custom_title TEXT,
  category TEXT,
  icon_url TEXT
);

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

-- Append-only behavior signals used by Pigeon Reader recommendations.
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
