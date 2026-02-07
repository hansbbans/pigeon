# RSS Serving

## Feed Generation

Each feed is served at `/feed/:feed_key` and returns valid Atom XML. We use Atom over RSS 2.0 because:
- Atom has a cleaner spec (RFC 4287)
- Better support for HTML content
- Required fields are well-defined
- Reeder Classic handles both equally well

## Atom Feed Template

```typescript
function generateAtomFeed(feed: FeedMeta, items: FeedItem[], baseUrl: string): string {
  const feedUrl = `${baseUrl}/feed/${feed.feed_key}`;
  const title = feed.custom_title || feed.display_name;
  
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(title)}</title>
  <link href="${escapeXml(feedUrl)}" rel="self" type="application/atom+xml"/>
  <link href="${escapeXml(baseUrl)}" rel="alternate" type="text/html"/>
  <id>${escapeXml(feedUrl)}</id>
  <updated>${items[0]?.received_at || new Date().toISOString()}</updated>
  <generator>Pigeon Newsletter-to-RSS</generator>
  <author>
    <name>${escapeXml(feed.display_name)}</name>
    ${feed.from_email ? `<email>${escapeXml(feed.from_email)}</email>` : ''}
  </author>
${items.map(item => `
  <entry>
    <title>${escapeXml(item.subject)}</title>
    <id>urn:uuid:${item.id}</id>
    <updated>${item.received_at}</updated>
    <published>${item.received_at}</published>
    <author>
      <name>${escapeXml(item.from_name || feed.display_name)}</name>
    </author>
    <content type="html">${escapeXml(item.html_content)}</content>
  </entry>`).join('\n')}
</feed>`;
}
```

## XML Escaping

Critical — newsletter content contains HTML which must be XML-escaped inside `<content>`:

```typescript
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
```

**Alternative:** Use CDATA sections to avoid escaping:
```xml
<content type="html"><![CDATA[
  <p>Raw HTML here without escaping</p>
]]></content>
```

CDATA is simpler and more reliable for large HTML blocks. Recommended approach:

```typescript
function wrapCDATA(html: string): string {
  // CDATA cannot contain "]]>" — escape it if present
  const safe = html.replace(/]]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

// In template:
// <content type="html">${wrapCDATA(item.html_content)}</content>
```

## HTTP Handler

```typescript
async function handleFeed(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const feedKey = url.pathname.replace('/feed/', '');
  
  if (!feedKey) {
    return new Response('Feed key required', { status: 400 });
  }
  
  // Get feed metadata
  const feed = await env.DB.prepare(
    'SELECT * FROM feeds WHERE feed_key = ? AND is_active = 1'
  ).bind(feedKey).first<FeedMeta>();
  
  if (!feed) {
    return new Response('Feed not found', { status: 404 });
  }
  
  // Get items
  const limit = parseInt(url.searchParams.get('limit') || String(env.ITEMS_PER_FEED || 50));
  const { results: items } = await env.DB.prepare(
    'SELECT id, subject, html_content, from_name, from_email, received_at, message_id FROM items WHERE feed_key = ? ORDER BY received_at DESC LIMIT ?'
  ).bind(feedKey, Math.min(limit, 100)).all<FeedItem>();
  
  const xml = generateAtomFeed(feed, items, env.BASE_URL);
  
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/atom+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300', // 5 min cache
      'ETag': `"${feed.last_item_at || 'empty'}"`,
    },
  });
}
```

## Cache Strategy

- `Cache-Control: public, max-age=300` — Cloudflare CDN and Reeder both cache for 5 minutes
- ETag based on `last_item_at` — Reeder sends `If-None-Match`, return 304 if unchanged
- This reduces D1 reads when Reeder polls frequently

```typescript
// Conditional GET support
const ifNoneMatch = request.headers.get('If-None-Match');
const etag = `"${feed.last_item_at || 'empty'}"`;

if (ifNoneMatch === etag) {
  return new Response(null, { status: 304 });
}
```

## Response Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Type` | `application/atom+xml; charset=utf-8` | Identifies as Atom feed |
| `Cache-Control` | `public, max-age=300` | 5 min CDN + client cache |
| `ETag` | `"<last_item_at>"` | Conditional GET support |
| `Access-Control-Allow-Origin` | `*` | Allow browser feed readers |

## Feed Pagination (Phase 5)

RFC 5005 "Feed Paging and Archiving" supports paginated feeds:

```xml
<link rel="next" href="https://feeds.domain.com/feed/key?before=2024-01-01T00:00:00Z"/>
<link rel="first" href="https://feeds.domain.com/feed/key"/>
```

Use cursor-based pagination with `received_at` as the cursor. Reeder Classic supports this.
