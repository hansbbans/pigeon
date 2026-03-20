-- SCHEMA V2: Add RSS feed subscription support
-- This migration extends the feeds table to support external RSS/Atom feeds
-- alongside email-based feeds.

-- Add RSS-specific columns to feeds table
ALTER TABLE feeds ADD COLUMN source_type TEXT NOT NULL DEFAULT 'email';
ALTER TABLE feeds ADD COLUMN source_url TEXT;
ALTER TABLE feeds ADD COLUMN fetch_interval_minutes INTEGER DEFAULT 60;
ALTER TABLE feeds ADD COLUMN last_fetched_at TEXT;
ALTER TABLE feeds ADD COLUMN fetch_error TEXT;
ALTER TABLE feeds ADD COLUMN etag TEXT;
ALTER TABLE feeds ADD COLUMN last_modified TEXT;

-- Index for efficient cron queries (find RSS feeds due for refresh)
CREATE INDEX IF NOT EXISTS idx_feeds_next_fetch
  ON feeds(source_type, last_fetched_at)
  WHERE source_type = 'rss' AND is_active = 1;

-- Update schema version
UPDATE _meta SET value = '2' WHERE key = 'schema_version';
