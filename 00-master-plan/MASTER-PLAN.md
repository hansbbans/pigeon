# Newsletter-to-RSS: Master Plan

## Project Codename: **Pigeon**

> Pigeon receives mail and delivers feeds.

## Mission

Build a serverless system that receives newsletter emails at a custom domain, stores them, and serves per-sender RSS/Atom feeds consumable by Reeder Classic. Built entirely on Cloudflare's free tier.

---

## Architecture Overview

```
Newsletter ESP ──► MX Records ──► Cloudflare Email Routing
                                        │
                                        ▼
                                  CF Worker (email handler)
                                        │
                                  ┌─────┴─────┐
                                  │ postal-mime │
                                  │   parse     │
                                  └─────┬─────┘
                                        │
                                   ┌────┴────┐
                                   │  D1 DB   │
                                   └────┬────┘
                                        │
                                  CF Worker (RSS handler)
                                        │
                                        ▼
                                  RSS/Atom XML
                                        │
                                        ▼
                                  Reeder Classic
```

---

## Phase Roadmap

### Phase 1: Foundation (Days 1-2)
- [ ] Domain + Cloudflare DNS setup
- [ ] Wrangler project scaffold
- [ ] Email routing → Worker pipeline
- [ ] Receive and log a raw email
- **Deliverable:** An email sent to `rss@yourdomain.com` triggers a Worker and logs to console

### Phase 2: Parse + Store (Days 3-4)
- [ ] Parse email with `postal-mime`
- [ ] Design D1 schema
- [ ] Write parsed email to D1
- [ ] Handle edge cases (multipart, encoding, inline images)
- **Deliverable:** Emails arrive and are stored as structured records in D1

### Phase 3: RSS Serving (Days 5-6)
- [ ] RSS/Atom XML generation endpoint
- [ ] Per-sender feed routing (`/feed/:feed_key`)
- [ ] Feed listing endpoint (`/feeds` → JSON + OPML)
- [ ] Test with Reeder Classic
- **Deliverable:** Subscribe to a feed URL in Reeder, see newsletter content

### Phase 4: Custom Parsing Rules (Days 7-8)
- [ ] Rule engine schema and storage
- [ ] CSS selector-based content extraction
- [ ] Per-sender rule configuration
- [ ] Rule testing/preview endpoint
- **Deliverable:** Can define "for sender X, extract only `.main-content` div"

### Phase 5: Hardening (Days 9-10)
- [ ] Error handling and dead letter logging
- [ ] Duplicate detection
- [ ] Feed pagination (RFC 5005)
- [ ] Basic auth or token auth on feed URLs
- [ ] OPML export for bulk Reeder import
- **Deliverable:** Production-grade reliability

### Phase 6: Future (Backlog)
- [ ] Forwarded email unwrapping — detect emails forwarded from a trusted sender (e.g. `hans.cho@gmail.com`), parse the original sender/subject/content from the forwarded body, and key the feed to the original sender instead
- [ ] Web UI for feed management
- [ ] Readability-mode toggle per feed
- [ ] Email forwarding rules (filter out promos)
- [ ] Webhook notifications on new items
- [ ] Full-text search across all newsletters
- [ ] Combined feeds — single Atom endpoint merging multiple feed keys into one Reeder source
- [ ] RSS polling — ingest traditional RSS/Atom feeds via Cron Trigger, store items in D1, mix with newsletters in combined feeds

---

## Knowledge Base Directory Map

```
newsletter-to-rss/
├── 00-master-plan/
│   ├── MASTER-PLAN.md              ← You are here
│   └── DECISIONS.md                ← Architecture Decision Records
├── 01-architecture/
│   ├── ARCHITECTURE.md             ← System design, data flow
│   ├── CLOUDFLARE-SETUP.md         ← DNS, email routing, wrangler config
│   └── TECH-STACK.md               ← Dependencies, versions, rationale
├── 02-email-ingestion/
│   ├── EMAIL-INGESTION.md          ← How emails arrive and get processed
│   ├── EMAIL-FORMAT-REFERENCE.md   ← MIME structure, multipart, encoding
│   └── POSTAL-MIME-USAGE.md        ← Library API, gotchas, examples
├── 03-parsing-engine/
│   ├── PARSING-ENGINE.md           ← HTML extraction pipeline
│   ├── SENDER-NORMALIZATION.md     ← From-address → feed_key logic
│   └── EDGE-CASES.md               ← Known weird newsletter formats
├── 04-storage/
│   ├── STORAGE.md                  ← D1 schema, indexes, queries
│   ├── SCHEMA.sql                  ← DDL for all tables
│   └── MIGRATIONS.md               ← Schema evolution strategy
├── 05-rss-serving/
│   ├── RSS-SERVING.md              ← Feed generation logic
│   ├── RSS-SPEC-REFERENCE.md       ← RSS 2.0 / Atom spec notes
│   └── REEDER-COMPAT.md           ← Reeder Classic specific behaviors
├── 06-feed-management/
│   ├── FEED-MANAGEMENT.md          ← Listing, OPML, discovery
│   └── OPML-SPEC.md               ← OPML format reference
├── 07-custom-parsing-rules/
│   ├── CUSTOM-RULES.md             ← Rule engine design
│   ├── RULE-SCHEMA.md              ← Rule definition format
│   └── EXAMPLES.md                 ← Example rules for common ESPs
├── 08-testing/
│   ├── TESTING.md                  ← Test strategy
│   └── TEST-EMAILS.md             ← How to generate test fixtures
├── 09-deployment/
│   ├── DEPLOYMENT.md               ← CI/CD, wrangler deploy
│   └── MONITORING.md               ← Error tracking, health checks
└── 10-future/
    └── FUTURE.md                   ← Backlog and ideas
```

---

## Tooling Strategy

### When to Use Claude Code vs Claude Project

| Task | Tool | Why |
|------|------|-----|
| Scaffold wrangler project, write Workers | Claude Code | File creation, terminal access, iterative coding |
| Debug email parsing edge cases | Claude Code | Needs to run code, inspect output |
| Design decisions, architecture review | Claude Project | Long-context reasoning, reference these docs |
| Write D1 migrations | Claude Code | SQL execution, schema testing |
| Research Cloudflare APIs, RSS spec | Claude Project | Web search, synthesis |
| Build and test RSS output | Claude Code | Needs to generate XML, validate |
| Write custom parsing rule engine | Claude Code | Complex logic, iterative |
| Troubleshoot Reeder compatibility | Claude Project | Research + reasoning |

### Claude Project Setup

Create a Claude Project called **"Pigeon — Newsletter to RSS"** and upload all files from this knowledge base as project context. This gives every conversation full awareness of the architecture, decisions, and current state.

### Claude Code Workflow

1. Start each session by telling Claude Code which Phase you're working on
2. Reference the relevant `.md` files from this knowledge base
3. Use `DECISIONS.md` as a living log — append every significant choice
4. Commit after each phase milestone

### Speed Multipliers

1. **MCP Builder skill** — If you want a local dev tool (e.g., a CLI to test email parsing locally), the MCP builder skill can scaffold that fast
2. **Test email fixtures** — Save 5-10 real newsletter `.eml` files early. Parse them all in Phase 2. This prevents "works on one email, breaks on real data"
3. **Wrangler local dev** — `wrangler dev --local` lets you test Workers + D1 locally without deploying. Use this constantly
4. **Miniflare** — Cloudflare's local simulator. Lets you test email events locally via the `EmailEvent` API
5. **`postal-mime` in Node** — You can test parsing logic in plain Node.js scripts before deploying to Workers. Faster iteration loop

---

## Success Criteria

- [ ] Send a newsletter to `rss@domain.com`, see it in Reeder within 60 seconds
- [ ] 30 newsletters producing 30 separate, clean RSS feeds
- [ ] Custom parsing rule successfully extracts content from one difficult newsletter
- [ ] Zero cost (Cloudflare free tier only)
- [ ] Full OPML export importable by Reeder in one action
