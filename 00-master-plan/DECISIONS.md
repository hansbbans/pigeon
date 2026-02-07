# Architecture Decision Records

## ADR-001: Cloudflare over AWS

**Decision:** Use Cloudflare Email Routing + Workers + D1 over AWS SES + Lambda + DynamoDB

**Rationale:**
- Cloudflare Email Routing is free, no per-email charges
- Workers + D1 free tier is more than sufficient for 30 newsletters
- Single platform (no cross-service IAM, no region selection)
- Email routing → Worker is a native integration, zero glue code
- `wrangler` CLI is simpler than SAM/CDK for this scale

**Tradeoff:** Less ecosystem flexibility if we outgrow Cloudflare. Acceptable — 30 newsletters won't outgrow it.

---

## ADR-002: Per-sender feeds with catch-all address

**Decision:** Use a single catch-all address (`rss@domain.com`) and auto-create feeds keyed by normalized sender email.

**Rationale:**
- Simplest onboarding: subscribe to any newsletter with one address
- Feed key derived from sender, no manual configuration needed
- Per-sender feeds give Reeder granular organization
- Can always add alias-based routing later

**Tradeoff:** Two newsletters from the same sender email end up in the same feed. Rare in practice. Can be handled later with subject-line rules in the custom parsing phase.

---

## ADR-003: Preserve raw HTML, don't clean

**Decision:** Store and serve the original newsletter HTML in RSS `<content:encoded>`.

**Rationale:**
- Newsletters already have absolute image URLs hosted by ESPs
- Reeder Classic renders HTML well
- Cleaning/Readability extraction loses layout, images, branding
- Custom parsing rules (Phase 4) can override per-sender if needed

**Tradeoff:** Some newsletters have tracking pixels and ugly markup. Acceptable — Reeder handles it fine. Phase 4 custom rules can strip tracking if desired.

---

## ADR-004: D1 over R2 for storage

**Decision:** Use D1 (SQLite) over R2 (object storage) for email content.

**Rationale:**
- Need to query by feed_key, order by date, paginate — relational operations
- HTML content per newsletter is typically 50-200KB, well within D1 row limits
- Single data store, no coordination between metadata DB and content store
- D1 free tier: 5GB storage, 5M reads/day — 30 newsletters × 365 days = ~11K rows/year

**Tradeoff:** D1 has a 1MB row size limit. Very large newsletters (rare) may need truncation. Monitor and handle in Phase 5 if needed.

---

## ADR-005: postal-mime for email parsing

**Decision:** Use `postal-mime` npm package for MIME parsing.

**Rationale:**
- Designed to run in Workers/browser environments (no Node.js-only APIs)
- Handles multipart/alternative, multipart/mixed, quoted-printable, base64
- Actively maintained, used by Cloudflare's own examples
- Returns structured object with html, text, attachments, headers

**Tradeoff:** Less battle-tested than `mailparser` (Node.js only, won't run in Workers). Acceptable given Workers constraint.

---

*Append new ADRs here as decisions are made during development.*
