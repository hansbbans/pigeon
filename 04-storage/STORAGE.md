# Storage Design (Cloudflare D1)

## Schema

```sql
-- Feeds metadata table
CREATE TABLE IF NOT EXISTS feeds (
  feed_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  from_email TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_item_at TEXT,
  item_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,        -- 0 = hidden from feed listing
  custom_title TEXT                     -- Override display_name in RSS
);

-- Newsletter items table
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,                  -- UUID
  feed_key TEXT NOT NULL,
  from_name TEXT,
  from_email TEXT,
  subject TEXT NOT NULL,
  html_content TEXT NOT NULL,
  text_content TEXT,                    -- Plain text fallback
  message_id TEXT UNIQUE,              -- RFC 5322 Message-ID for dedup
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  content_size INTEGER,                 -- bytes, for monitoring
  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_items_feed_key_date ON items(feed_key, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_received_at ON items(received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_message_id ON items(message_id);

-- Custom parsing rules (Phase 4)
CREATE TABLE IF NOT EXISTS parsing_rules (
  id TEXT PRIMARY KEY,
  feed_key TEXT NOT NULL,               -- Which feed this rule applies to
  rule_type TEXT NOT NULL,              -- 'css_selector', 'regex', 'strip'
  rule_config TEXT NOT NULL,            -- JSON config for the rule
  priority INTEGER DEFAULT 0,          -- Higher = runs first
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (feed_key) REFERENCES feeds(feed_key)
);

CREATE INDEX IF NOT EXISTS idx_rules_feed_key ON parsing_rules(feed_key, priority DESC);
```

## Key Queries

### Insert new item (with feed upsert)
```sql
-- Step 1: Upsert feed
INSERT INTO feeds (feed_key, display_name, from_email, first_seen_at, last_item_at, item_count)
VALUES (?1, ?2, ?3, ?4, ?4, 1)
ON CONFLICT(feed_key) DO UPDATE SET
  last_item_at = ?4,
  item_count = item_count + 1,
  display_name = COALESCE(feeds.display_name, ?2);

-- Step 2: Insert item (skip if duplicate message_id)
INSERT OR IGNORE INTO items (id, feed_key, from_name, from_email, subject, html_content, text_content, message_id, received_at, content_size)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);
```

### Get feed items (for RSS generation)
```sql
SELECT id, subject, html_content, from_name, from_email, received_at, message_id
FROM items
WHERE feed_key = ?
ORDER BY received_at DESC
LIMIT ?;
```

### List all feeds (for /feeds endpoint)
```sql
SELECT feed_key, display_name, from_email, item_count, last_item_at, custom_title
FROM feeds
WHERE is_active = 1
ORDER BY last_item_at DESC;
```

### Get parsing rules for a feed
```sql
SELECT rule_type, rule_config
FROM parsing_rules
WHERE feed_key = ? AND is_active = 1
ORDER BY priority DESC;
```

## D1 Batch Operations

D1 supports batching multiple statements in a single call, which reduces roundtrips:

```typescript
await env.DB.batch([
  env.DB.prepare('INSERT INTO feeds ...').bind(...),
  env.DB.prepare('INSERT OR IGNORE INTO items ...').bind(...),
]);
```

Always batch the feed upsert + item insert together.

## Storage Estimates

| Metric | Estimate |
|--------|----------|
| Avg HTML per newsletter | ~100KB |
| Newsletters per day | ~5-10 (30 newsletters, most aren't daily) |
| Items per year | ~2,500 |
| Storage per year | ~250MB |
| D1 free tier | 5GB |
| Years before hitting limit | ~20 |

## Data Retention

No immediate need for cleanup, but the schema supports it:

```sql
-- Delete items older than 1 year (if ever needed)
DELETE FROM items WHERE received_at < datetime('now', '-1 year');

-- Update feed item counts after cleanup
UPDATE feeds SET item_count = (SELECT COUNT(*) FROM items WHERE items.feed_key = feeds.feed_key);
```

## Migration Strategy

D1 doesn't have a built-in migration system. Strategy:

1. Store schema version in a `_meta` table
2. On Worker startup, check version and run pending migrations
3. Keep migrations idempotent (use `IF NOT EXISTS`, `OR IGNORE`)

```sql
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1');
```

See MIGRATIONS.md for the migration runner pattern.
