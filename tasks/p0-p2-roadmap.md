# Pigeon P0-P2 Implementation Tracker

This checklist tracks the complete P0-P2 implementation program derived from the
NetNewsWire comparison. A checked item must have implementation evidence and a
passing focused regression test. Merge, deployment, TestFlight, and a separate
native Mac app are outside this program.

## Global completion gates

- [ ] Every item below is implemented or explicitly removed from scope by Hans.
- [ ] Every pull request has focused regression coverage and passes the full Worker suite.
- [ ] `npx tsc --noEmit` passes.
- [ ] Native unit and UI tests pass on a supported iPhone simulator.
- [ ] Debug and unsigned Release simulator builds pass with zero first-party warnings.
- [ ] Production dependency audit reports no known vulnerabilities.
- [ ] The dirty primary checkout remains untouched.
- [ ] No PR is merged, deployed, or released without separate authorization.

## PR 1 - Feed trust and quality gates

### Continuous integration and test data

- [x] Run Worker tests and TypeScript checks for pull requests and `main` pushes.
- [x] Run native unit tests and a bounded UI smoke suite in pull-request CI.
- [x] Fail CI on first-party Swift warnings.
- [x] Upload useful test result bundles when native tests fail.
- [x] Add dependency-audit coverage and resolve current development-tool advisories.
- [x] Add a checked-in feed corpus with at least 50 representative fixtures.
- [x] Cover RSS 2.0, RSS 1.0/RDF, Atom, JSON Feed, empty feeds, malformed dates,
      namespaces, relative links, duplicate/missing identifiers, redirects, large
      responses, non-feed payloads, and newsletter-originated content.

### Feed discovery and subscription

- [x] Accept ordinary website URLs as well as direct feed URLs.
- [x] Detect direct RSS, RDF, Atom, and JSON feeds.
- [x] Discover HTML `<link rel="alternate">` feed declarations.
- [x] Probe independent feed candidates without letting one failure cancel the rest.
- [x] Try bounded common fallbacks such as `/feed/` and `/index.xml`.
- [x] Rank multiple candidates and return a subscription preview.
- [x] Track canonical feed URLs and aliases so redirects cannot create duplicates.
- [x] Validate URL safety initially and after every redirect.
- [x] Reject credentials, unsafe ports, loopback, private, link-local, and internal targets.

### Parsing and content safety

- [x] Parse RSS 2.0.
- [x] Parse RSS 1.0/RDF.
- [x] Parse Atom, including valid empty feeds.
- [x] Parse JSON Feed.
- [x] Tolerate common namespace, case, entity, and date problems deterministically.
- [x] Resolve relative feed, item, media, and content URLs.
- [x] Use stable item identity fallbacks without treating an invalid date as "now."
- [x] Enforce a response byte limit before buffering the entire body.
- [x] Reject obvious image, archive, audio, video, and unrelated HTML payloads.

### Refresh scheduling and storage

- [x] Track last attempt separately from last successful refresh.
- [x] Track next eligible refresh, consecutive failures, last HTTP status,
      `Retry-After`, content hash, and an active refresh lease.
- [x] Use bounded global and per-host concurrency.
- [x] Apply exponential backoff with deterministic jitter.
- [x] Honor reasonable `Retry-After` and `Cache-Control` values.
- [x] Prevent overlapping cron runs from refreshing the same feed concurrently.
- [x] Keep old/deferred feeds fair when more than one batch is due.
- [x] Do not delay the next attempt after a connectivity failure as if it succeeded.
- [x] Skip parsing when the downloaded content hash is unchanged.
- [x] Periodically bypass broken conditional-request metadata.
- [x] Separate immutable article content from mutable read/starred/arrival status.
- [x] Retain unread and starred material and keep statuses longer than article bodies.
- [x] Keep a minimum useful history per feed while preventing unbounded storage growth.

### Sync health

- [x] Expose current refresh activity and aggregate health through an authenticated API.
- [x] Expose per-feed last success, latest outcome, and next retry.
- [x] Support safe manual retry.
- [x] Provide redacted diagnostics without credentials, article bodies, email addresses,
      or recommendation history.
- [x] Add native Sync Health UI for the same information.

### PR 1 verification evidence

- 61 checked-in feed documents cover the accepted formats and hostile/edge inputs.
- 267 Worker tests pass, followed by TypeScript checking and a zero-vulnerability audit.
- 111 native unit tests and 7 iPhone UI tests pass from a clean derived-data directory.
- Clean unsigned Release simulator build passes; both native logs contain zero first-party warnings.
- A Wrangler dry run bundles the Worker successfully without publishing it.

## PR 2 - Offline-first native library and synchronization

- [ ] Add an account-scoped local SQLite library.
- [ ] Persist feeds, folders, article metadata, sanitized bodies, statuses,
      recommendations, sync cursors, and pending actions.
- [ ] Load cached navigation and articles before networking.
- [ ] Add a bounded incremental-sync API and stable cursor semantics.
- [ ] Add a durable outbox for read, unread, star, unstar, mark-all/above/below,
      recommendation feedback, rename, move, and unsubscribe operations.
- [ ] Give every pending operation a stable idempotency key.
- [ ] Reconcile optimistic state without double-applying successful operations.
- [ ] Preserve pending work across termination, cancellation, and connectivity loss.
- [ ] Prevent account cache, status, filter, or selection leakage.
- [ ] Restore collection, article, scroll position, Reader mode, filters, sort order,
      expanded folders, and compact-column state.
- [ ] Add cleanup controls and storage statistics.
- [ ] Verify airplane-mode launch and reading with representative cached content.

## PR 3 - Reading velocity, readability, accessibility, and personalization

### Reading workflows

- [ ] Search titles, authors, feeds, summaries, and cached article bodies.
- [ ] Scope search to a feed, folder, smart view, or the full library.
- [ ] Find text within the open article.
- [ ] Navigate to the next unread article across feed boundaries.
- [ ] Add oldest-first sorting.
- [ ] Add configurable mark-read-on-open and mark-read-on-scroll behavior.
- [ ] Add undo for mark all/above/below/older-than-date actions.
- [ ] Preserve the open article when filters or status changes remove it from the list.
- [ ] Wire the system share sheet into the article UI.
- [ ] Add title-only, compact, comfortable, and image-rich timeline densities.
- [ ] Show last-updated and cached/live state.

### Readability, accessibility, and privacy

- [ ] Add system, light, dark, and sepia reading themes.
- [ ] Add adjustable margins and reading-column width.
- [ ] Keep an explicit per-feed Feed Content, Reader View, or Website default.
- [ ] Improve tables, code blocks, captions, block quotes, and wide newsletters.
- [ ] Add normal, blocked-until-requested, and privacy-proxied remote image policies.
- [ ] Explain publisher-visible remote content behavior.
- [ ] Complete VoiceOver, Voice Control, and hardware-keyboard coverage.
- [ ] Verify accessibility Dynamic Type sizes, Reduce Motion, contrast, and non-color cues.

### Trustworthy personalization

- [ ] Keep bulk read state neutral and prioritize explicit positive/negative feedback.
- [ ] Show a plain-language "Why this?" explanation for every recommendation.
- [ ] Add preference reset, feedback history, delete, and export controls.
- [ ] Add feed/topic diversity, freshness, and exploration constraints.
- [ ] Exclude pending or failed actions from confirmed training signals.
- [ ] Publish concise signal and retention behavior in the app.

## PR 4 - Background delivery and platform integration

- [ ] Add best-effort background refresh with constrained/Low Data Mode handling.
- [ ] Add per-feed notifications with Mark Read and Star actions.
- [ ] Add Home and Lock Screen widgets for counts and recent/For You articles.
- [ ] Add deep links into feeds, folders, and articles.
- [ ] Add a Share Extension and App Intent for adding a website or feed.
- [ ] Add OPML import with preview, duplicate detection, merge behavior, and rollback.
- [ ] Add a Stale Feeds view with last article, last success, HTTP result,
      bulk unsubscribe/archive, and undo.

## Final evidence review

- [ ] Verify no duplicate items under overlapping refresh and retry simulations.
- [ ] Verify `429` feeds are not contacted before their retry time.
- [ ] Verify one failing host does not block unrelated feeds.
- [ ] Verify offline actions replay exactly once after reconnection.
- [ ] Verify an old undated item cannot reappear as newly unread.
- [ ] Verify starred articles survive normal cleanup.
- [ ] Verify cached launch, local search, and accessibility acceptance targets.
- [ ] Review the complete stacked diff for secrets, sensitive content, and unrelated files.
- [ ] Record exact commits, test results, open PRs, and remaining external-only gates.
