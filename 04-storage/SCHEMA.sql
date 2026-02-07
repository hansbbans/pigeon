-- Pigeon: Newsletter-to-RSS
-- D1 Schema v1

-- Schema version tracking
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1');

-- Feeds metadata
CREATE TABLE IF NOT EXISTS feeds (
  feed_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  from_email TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_item_at TEXT,
  item_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  custom_title TEXT
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
  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key)
);

CREATE INDEX IF NOT EXISTS idx_items_feed_key_date ON items(feed_key, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_received_at ON items(received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_message_id ON items(message_id);

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
