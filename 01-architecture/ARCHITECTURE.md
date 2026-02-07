# System Architecture

## Data Flow

### Email Ingestion Flow
```
1. Newsletter ESP sends email to rss@yourdomain.com
2. Cloudflare DNS MX records route to CF Email Routing
3. Email Routing triggers Worker via `email` event handler
4. Worker receives `EmailMessage` object with raw stream
5. Worker reads stream → passes to postal-mime
6. postal-mime returns parsed object:
   {
     from: { address, name },
     subject: string,
     html: string,
     text: string,
     date: string,
     messageId: string,
     headers: Map
   }
7. Worker normalizes sender → feed_key
8. Worker writes record to D1
9. Done (no response needed for email handler)
```

### RSS Serving Flow
```
1. Reeder Classic polls GET /feed/:feed_key
2. Worker receives HTTP request
3. Worker queries D1: SELECT * FROM items WHERE feed_key = ? ORDER BY received_at DESC LIMIT 50
4. Worker builds RSS/Atom XML from results
5. Returns XML with Content-Type: application/atom+xml
6. Reeder parses and displays
```

### Feed Discovery Flow
```
1. User hits GET /feeds (JSON) or GET /feeds/opml (OPML XML)
2. Worker queries D1: SELECT DISTINCT feed_key, from_name, from_email, COUNT(*) as item_count FROM items GROUP BY feed_key
3. Returns list of all feeds with metadata
4. OPML variant returns importable XML for Reeder
```

## Worker Architecture

Single Wrangler project, single Worker with two entry points:

```typescript
export default {
  // HTTP requests (RSS feeds, feed listing, OPML)
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname.startsWith('/feed/')) return handleFeed(request, env);
    if (url.pathname === '/feeds') return handleFeedList(request, env);
    if (url.pathname === '/feeds/opml') return handleOPML(request, env);
    if (url.pathname === '/health') return new Response('ok');
    
    return new Response('Not found', { status: 404 });
  },
  
  // Email events (newsletter ingestion)
  async email(message: EmailMessage, env: Env): Promise<void> {
    await handleIncomingEmail(message, env);
  }
};
```

## Environment Bindings

```toml
# wrangler.toml
name = "pigeon"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "pigeon-db"
database_id = "<generated>"

[vars]
FEED_TITLE_PREFIX = "Pigeon"
ITEMS_PER_FEED = 50
BASE_URL = "https://feeds.yourdomain.com"
```

## URL Scheme

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/feed/:feed_key` | GET | RSS/Atom feed for a specific sender |
| `/feed/:feed_key?format=atom` | GET | Force Atom format |
| `/feed/:feed_key?format=rss` | GET | Force RSS 2.0 format |
| `/feeds` | GET | JSON list of all feeds |
| `/feeds/opml` | GET | OPML export of all feeds |
| `/health` | GET | Health check |

## Security Considerations

- **Phase 1-3:** No auth. Feeds are public URLs (security through obscurity via feed_key)
- **Phase 5:** Add optional bearer token auth on feed URLs
- Email handler has no auth surface — Cloudflare Email Routing only sends verified emails
- D1 is not publicly accessible, only via Worker bindings
- No PII concerns beyond email addresses (which are already public newsletter senders)
