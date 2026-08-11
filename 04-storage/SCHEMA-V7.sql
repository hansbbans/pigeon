-- Pigeon schema v7: append-only native-reader engagement events.

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

UPDATE _meta SET value = '7' WHERE key = 'schema_version';
