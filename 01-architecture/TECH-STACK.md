# Tech Stack

## Runtime & Platform

| Component | Choice | Version | Notes |
|-----------|--------|---------|-------|
| Runtime | Cloudflare Workers | V8 isolates | Not Node.js — no `fs`, `net`, `crypto` (use Web APIs) |
| Database | Cloudflare D1 | SQLite-based | 5GB free, 5M reads/day, 100K writes/day |
| Email | Cloudflare Email Routing | — | Free, routes to Worker |
| CLI | Wrangler | 3.x | `npm install -g wrangler` |
| Language | TypeScript | 5.x | Workers have native TS support via wrangler |

## Dependencies

| Package | Purpose | Workers Compatible | Notes |
|---------|---------|-------------------|-------|
| `postal-mime` | MIME email parsing | ✅ Yes | Designed for browser/worker environments |
| — | RSS/Atom XML generation | N/A | Hand-roll. No good Workers-compatible RSS lib. `feed` package uses Node APIs |

### Why hand-roll RSS XML?

The `feed` npm package (most popular RSS generator) uses Node.js `url` module internally. It won't run in Workers without polyfills. RSS/Atom XML is simple enough that a 50-line template function is cleaner than fighting polyfill issues.

## Workers Runtime Constraints

**Available Web APIs:**
- `fetch`, `Request`, `Response`, `Headers`
- `URL`, `URLSearchParams`
- `TextEncoder`, `TextDecoder`
- `crypto.subtle` (Web Crypto)
- `ReadableStream`, `WritableStream`
- `structuredClone`
- `Date`, `JSON`, `console`

**NOT available:**
- `fs`, `path`, `os` (no filesystem)
- `net`, `http` (use `fetch`)
- `Buffer` (use `Uint8Array` + `TextEncoder`)
- `process` (no process object)
- `require()` (ESM only)

**Limits (free tier):**
- CPU time: 10ms per request (sufficient for our use)
- Memory: 128MB
- Request size: 100MB
- D1 row size: 1MB (watch for huge newsletters)
- Subrequest limit: 50 per request

## Development Tools

| Tool | Purpose |
|------|---------|
| `wrangler dev --local` | Local development server |
| `wrangler d1 execute` | Run SQL against D1 (local or remote) |
| `wrangler deploy` | Deploy to production |
| `wrangler tail` | Live log streaming from production |
| Miniflare | Local Workers simulator (built into wrangler) |
