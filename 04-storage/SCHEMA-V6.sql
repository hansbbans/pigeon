-- Add multi-label support for reader folders/tags.
CREATE TABLE IF NOT EXISTS feed_tags (
  feed_key TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (feed_key, label),
  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key)
);

CREATE INDEX IF NOT EXISTS idx_feed_tags_label ON feed_tags(label, feed_key);

INSERT OR IGNORE INTO feed_tags (feed_key, label)
SELECT feed_key, category
FROM feeds
WHERE category IS NOT NULL AND category <> '';

UPDATE _meta SET value = '6' WHERE key = 'schema_version';
