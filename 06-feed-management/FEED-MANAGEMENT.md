# Feed Management

## Endpoints

### GET /feeds — List All Feeds (JSON)

Returns all active feeds with metadata.

```typescript
async function handleFeedList(request: Request, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`
    SELECT feed_key, display_name, from_email, item_count, last_item_at, custom_title
    FROM feeds
    WHERE is_active = 1
    ORDER BY last_item_at DESC
  `).all<FeedMeta>();
  
  const feeds = results.map(f => ({
    feed_key: f.feed_key,
    title: f.custom_title || f.display_name,
    from_email: f.from_email,
    item_count: f.item_count,
    last_item_at: f.last_item_at,
    feed_url: `${env.BASE_URL}/feed/${f.feed_key}`,
  }));
  
  return new Response(JSON.stringify({ feeds }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

### GET /feeds/opml — OPML Export

```typescript
async function handleOPML(request: Request, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`
    SELECT feed_key, display_name, custom_title
    FROM feeds
    WHERE is_active = 1
    ORDER BY display_name
  `).all<FeedMeta>();
  
  const outlines = results.map(f => {
    const title = escapeXml(f.custom_title || f.display_name);
    const url = escapeXml(`${env.BASE_URL}/feed/${f.feed_key}`);
    return `      <outline type="rss" text="${title}" title="${title}" xmlUrl="${url}"/>`;
  }).join('\n');
  
  const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Pigeon Newsletter Feeds</title>
    <dateCreated>${new Date().toISOString()}</dateCreated>
  </head>
  <body>
    <outline text="Newsletters" title="Newsletters">
${outlines}
    </outline>
  </body>
</opml>`;
  
  return new Response(opml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="pigeon-feeds.opml"',
    },
  });
}
```

## Feed Lifecycle

1. **Auto-created:** First email from a sender creates the feed entry
2. **Active by default:** `is_active = 1`, appears in listings and OPML
3. **Deactivate:** Set `is_active = 0` to hide from listings (items still stored, feed URL still works)
4. **Custom title:** Override `display_name` with `custom_title` for cleaner names in Reeder

## Future: Management API (Phase 6)

For a web UI or CLI management tool:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/feeds` | GET | List all feeds |
| `/api/feeds/:key` | PATCH | Update feed (title, active status) |
| `/api/feeds/:key` | DELETE | Deactivate feed |
| `/api/feeds/:key/items` | GET | List items in feed |
| `/api/feeds/:key/items/:id` | DELETE | Remove specific item |
| `/api/feeds/:key/rules` | GET/POST | Manage parsing rules |

These would need auth (bearer token or basic auth). Not needed for MVP.
