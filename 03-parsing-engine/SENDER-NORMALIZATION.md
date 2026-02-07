# Sender Normalization

## Goal

Map every incoming email to a stable `feed_key` string that:
- Groups emails from the same newsletter into one feed
- Is URL-safe (used in `/feed/:feed_key`)
- Is deterministic (same sender always → same key)
- Handles ESP quirks (Substack, Mailchimp shared sender addresses)

## Resolution Order

```typescript
function resolveFeedKey(parsed: ParsedEmail, rawFrom: string): string {
  // Priority 1: List-Id header (most reliable for mailing lists)
  const listId = extractListId(parsed);
  if (listId) return normalizeFeedKey(listId);
  
  // Priority 2: Reply-To if different from From (indicates real sender behind ESP)
  const replyTo = parsed.replyTo?.[0]?.address?.toLowerCase();
  const fromAddr = parsed.from?.address?.toLowerCase() || rawFrom.toLowerCase();
  if (replyTo && replyTo !== fromAddr) {
    return normalizeFeedKey(replyTo);
  }
  
  // Priority 3: From address
  return normalizeFeedKey(fromAddr);
}

function extractListId(parsed: ParsedEmail): string | null {
  const header = parsed.headers.find(h => h.key === 'list-id')?.value;
  if (!header) return null;
  
  // List-Id format: "Human Name <machine-id.domain.com>"
  const match = header.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

function normalizeFeedKey(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/@/g, '-at-')
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
```

## Examples

| From | List-Id | Reply-To | Resolved Feed Key |
|------|---------|----------|-------------------|
| `news@morningbrew.com` | `<mb.morningbrew.com>` | — | `mb.morningbrew.com` |
| `noreply@substack.com` | `<stratechery.substack.com>` | `ben@stratechery.com` | `stratechery.substack.com` |
| `hello@tldrnewsletter.com` | — | — | `hello-at-tldrnewsletter.com` |
| `no-reply@convertkit.com` | — | `author@blog.com` | `author-at-blog.com` |

## Storing the Display Name

The feed key is for routing. Also store a human-readable name for the feed:

```typescript
function resolveFeedDisplayName(parsed: ParsedEmail): string {
  // Try List-Id human-readable portion
  const listIdHeader = parsed.headers.find(h => h.key === 'list-id')?.value;
  if (listIdHeader) {
    const humanName = listIdHeader.replace(/<[^>]+>/, '').trim();
    if (humanName) return humanName;
  }
  
  // Fall back to From name
  return parsed.from?.name || parsed.from?.address || 'Unknown';
}
```

## Feed Metadata Table

When a new feed_key is first seen, create an entry in a `feeds` table:

```sql
CREATE TABLE IF NOT EXISTS feeds (
  feed_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  from_email TEXT,
  first_seen_at TEXT NOT NULL,
  last_item_at TEXT,
  item_count INTEGER DEFAULT 0
);
```

Update on every new item:
```sql
INSERT INTO feeds (feed_key, display_name, from_email, first_seen_at, last_item_at, item_count)
VALUES (?, ?, ?, ?, ?, 1)
ON CONFLICT(feed_key) DO UPDATE SET
  last_item_at = excluded.last_item_at,
  item_count = item_count + 1;
```
