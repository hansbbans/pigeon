# CLAUDE.md — Claude Code Project Instructions

## Project: Pigeon (Newsletter-to-RSS)

You are building a serverless newsletter-to-RSS converter on Cloudflare Workers + D1.

## Architecture

- **Email ingestion:** Cloudflare Email Routing → Worker `email()` handler
- **Email parsing:** `postal-mime` library
- **Storage:** Cloudflare D1 (SQLite)
- **RSS serving:** Worker `fetch()` handler generating Atom XML
- **Feed routing:** Per-sender feeds, keyed by normalized sender address

## Key Files

- `00-master-plan/MASTER-PLAN.md` — Full project plan and phases
- `00-master-plan/DECISIONS.md` — Architecture Decision Records (append here)
- `01-architecture/ARCHITECTURE.md` — System design and data flow
- `01-architecture/CLOUDFLARE-SETUP.md` — DNS, email routing, wrangler config
- `01-architecture/TECH-STACK.md` — Dependencies and Workers runtime constraints
- `02-email-ingestion/EMAIL-INGESTION.md` — Email processing pipeline
- `02-email-ingestion/POSTAL-MIME-USAGE.md` — postal-mime API and gotchas
- `03-parsing-engine/SENDER-NORMALIZATION.md` — Feed key resolution logic
- `03-parsing-engine/EDGE-CASES.md` — Known problematic patterns
- `04-storage/STORAGE.md` — D1 schema, queries, estimates
- `04-storage/SCHEMA.sql` — DDL (run this to initialize D1)
- `05-rss-serving/RSS-SERVING.md` — Atom feed generation
- `05-rss-serving/REEDER-COMPAT.md` — Reeder Classic compatibility notes
- `06-feed-management/FEED-MANAGEMENT.md` — Feed listing, OPML export
- `07-custom-parsing-rules/CUSTOM-RULES.md` — Rule engine design (Phase 4)
- `08-testing/TESTING.md` — Test strategy and fixtures

## Conventions

- TypeScript, strict mode
- ESM only (Workers don't support CJS)
- Use `crypto.randomUUID()` for IDs
- Use D1 `batch()` for multi-statement operations
- All dates in ISO 8601 UTC
- Feed keys are URL-safe lowercase strings
- XML generation: use CDATA for HTML content in Atom entries
- Error handling: catch and log, don't rethrow in email handler (prevents retry loops)

## Current Phase

Start with Phase 1 (Foundation) from MASTER-PLAN.md. Initialize the wrangler project, install `postal-mime`, and get a basic email handler that logs received emails.

## Important Constraints

- Workers runtime is V8, NOT Node.js — no `fs`, `Buffer`, `require()`
- D1 rows max 1MB — check content size before insert
- `postal-mime` must be used for email parsing (it's Workers-compatible, `mailparser` is not)
- RSS XML is hand-rolled (the `feed` npm package uses Node APIs)
- Email handler cannot be tested locally — use real emails or saved .eml fixtures
- Always use `INSERT OR IGNORE` with `message_id` UNIQUE index for deduplication
