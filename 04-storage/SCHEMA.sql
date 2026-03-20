-- Pigeon: Newsletter-to-RSS
-- D1 Schema v3

-- Schema version tracking
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '3');

-- Feeds metadata
CREATE TABLE IF NOT EXISTS feeds (
  feed_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  from_email TEXT,
  source_type TEXT NOT NULL DEFAULT 'email',
  source_url TEXT,
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

-- Newsletter items
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  feed_key TEXT NOT NULL,
  from_name TEXT,
  from_email TEXT,
  subject TEXT NOT NULL,
  html_content TEXT NOT NULL,
  text_content TEXT,
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
