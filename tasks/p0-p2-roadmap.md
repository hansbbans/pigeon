# Pigeon P0-P2 Implementation Tracker

This checklist tracks the complete P0-P2 implementation program derived from the
NetNewsWire comparison. A checked item must have implementation evidence and a
passing focused regression test. Merge, deployment, TestFlight, and a separate
native Mac app are outside this program.

## Global completion gates

- [x] Every item below is implemented or explicitly removed from scope by Hans.
- [x] Every pull request has focused regression coverage and passes the full Worker suite.
- [x] `npx tsc --noEmit` passes.
- [x] Native unit and UI tests pass on a supported iPhone simulator.
- [x] Debug and unsigned Release simulator builds pass with zero first-party warnings.
- [x] Production dependency audit reports no known vulnerabilities.
- [x] The dirty primary checkout remains untouched.
- [x] No PR is merged, deployed, or released without separate authorization.

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

- [x] Add an account-scoped local SQLite library.
- [x] Persist feeds, folders, article metadata, sanitized bodies, statuses,
      recommendations, sync cursors, and pending actions.
- [x] Load cached navigation and articles before networking.
- [x] Add a bounded incremental-sync API and stable cursor semantics.
- [x] Add a durable outbox for read, unread, star, unstar, mark-all/above/below,
      recommendation feedback, rename, move, and unsubscribe operations.
- [x] Give every pending operation a stable idempotency key.
- [x] Reconcile optimistic state without double-applying successful operations.
- [x] Preserve pending work across termination, cancellation, and connectivity loss.
- [x] Prevent account cache, status, filter, or selection leakage.
- [x] Restore collection, article, scroll position, Reader mode, filters, sort order,
      expanded folders, and compact-column state.
- [x] Add cleanup controls and storage statistics.
- [x] Verify airplane-mode launch and reading with representative cached content.

### PR 2 verification evidence

- Schema v10 adds an ordered change log and atomic mutation receipts; sync pages are
  limited to 200 changes and mutation requests to 100 actions/200 item references.
- Native SQLite tests prove account isolation, relaunch persistence, sanitized bodies,
  transactional cursors, cleanup protection, and lost-response replay behavior.
- 273 Worker tests pass with TypeScript checking and a zero-vulnerability audit.
- 122 native unit tests and 7 iPhone UI tests pass; the clean unsigned Release build
  passes and all native logs contain zero first-party warnings.
- A Wrangler dry run bundles the Worker successfully without publishing it.

## PR 3 - Reading velocity, readability, accessibility, and personalization

### Reading workflows

- [x] Search titles, authors, feeds, summaries, and cached article bodies.
- [x] Scope search to a feed, folder, smart view, or the full library.
- [x] Find text within the open article.
- [x] Navigate to the next unread article across feed boundaries.
- [x] Add oldest-first sorting.
- [x] Add configurable mark-read-on-open and mark-read-on-scroll behavior.
- [x] Add undo for mark all/above/below/older-than-date actions.
- [x] Preserve the open article when filters or status changes remove it from the list.
- [x] Wire the system share sheet into the article UI.
- [x] Add title-only, compact, comfortable, and image-rich timeline densities.
- [x] Show last-updated and cached/live state.

### Readability, accessibility, and privacy

- [x] Add system, light, dark, and sepia reading themes.
- [x] Add adjustable margins and reading-column width.
- [x] Keep an explicit per-feed Feed Content, Reader View, or Website default.
- [x] Improve tables, code blocks, captions, block quotes, and wide newsletters.
- [x] Add normal, blocked-until-requested, and privacy-proxied remote image policies.
- [x] Explain publisher-visible remote content behavior.
- [x] Complete VoiceOver, Voice Control, and hardware-keyboard coverage.
- [x] Verify accessibility Dynamic Type sizes, Reduce Motion, contrast, and non-color cues.

### Trustworthy personalization

- [x] Keep bulk read state neutral and prioritize explicit positive/negative feedback.
- [x] Show a plain-language "Why this?" explanation for every recommendation.
- [x] Add preference reset, feedback history, delete, and export controls.
- [x] Add feed/topic diversity, freshness, and exploration constraints.
- [x] Exclude pending or failed actions from confirmed training signals.
- [x] Publish concise signal and retention behavior in the app.

### PR 3 verification evidence

- Local SQLite search proves account and collection isolation across title, author,
  source, summary text, and sanitized cached HTML.
- Bulk read undo writes a durable reverse mutation; mark-on-open/scroll, cross-feed
  navigation, oldest sorting, and hidden-row selection all have model regressions.
- The image proxy rejects internal redirects, active content, and responses above 8 MiB;
  only authenticated raster responses reach the nonpersistent reader web view.
- Recommendation tests prove bulk neutrality, confirmed-only history, individual delete,
  reset/export, source/topic caps, freshness scoring, and a deterministic exploration slot.
- 279 Worker tests, 127 native unit tests, and 8 native UI tests pass, including an
  accessibility-size reader flow; native logs contain zero first-party warnings.

## PR 4 - Background delivery and platform integration

- [x] Add best-effort background refresh with constrained/Low Data Mode handling.
- [x] Add per-feed notifications with Mark Read and Star actions.
- [x] Add Home and Lock Screen widgets for counts and recent/For You articles.
- [x] Add deep links into feeds, folders, and articles.
- [x] Add a Share Extension and App Intent for adding a website or feed.
- [x] Add OPML import with preview, duplicate detection, merge behavior, and rollback.
- [x] Add a Stale Feeds view with last article, last success, HTTP result,
      bulk unsubscribe/archive, and undo.

### PR 4 verification evidence

- Schema v11 adds reversible stale-feed archiving, while the API returns a bounded
  500-feed inventory and limits each archive/unarchive request to 100 feeds.
- Background work uses incremental sync, a cache-aware article delta, network-cost
  policy, and persisted notification actions so cold launches do not alert on old
  history or lose Mark Read/Star requests.
- OPML import rejects oversized or non-OPML documents, caps work at 2,000 feeds,
  merges repeated folders, detects server-canonical duplicates, and rolls back only
  subscriptions and folder changes created by the import.
- Debug and unsigned Release builds embed the widget and share extensions, declare
  the app-group/deep-link/background capabilities, and contain App Intent metadata.
- 282 Worker tests, 137 native unit tests, and 9 native UI tests pass; TypeScript,
  dependency audit, Wrangler dry run, and first-party warning checks also pass.

## Final evidence review

- [x] Verify no duplicate items under overlapping refresh and retry simulations.
- [x] Verify `429` feeds are not contacted before their retry time.
- [x] Verify one failing host does not block unrelated feeds.
- [x] Verify offline actions replay exactly once after reconnection.
- [x] Verify an old undated item cannot reappear as newly unread.
- [x] Verify starred articles survive normal cleanup.
- [x] Verify cached launch, local search, and accessibility acceptance targets.
- [x] Review the complete stacked diff for secrets, sensitive content, and unrelated files.
- [x] Record exact commits, test results, open PRs, and remaining external-only gates.

Signed-device confirmation of background scheduling, notification delivery, widget
refresh timing, share-extension handoff, and App Group behavior remains a release
gate rather than an implementation blocker. No production publish was performed.
