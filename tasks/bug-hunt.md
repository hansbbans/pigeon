# Project audit 2026-11-09

Scope: whole repo (Worker, web reader, extension, iOS app, CI, docs), with state machines traced per area. Not time-boxed: one full read of every area by eight read-only auditors, then fixes.
Branch: claude/bug-hunt-2026-11-09 (cut from origin/main f5ce68e, rebased onto 895f74a after PR #177 merged mid-audit).
After the fixes and the review round: `npm test` 1140 tests, 1138 pass, 2 skipped; `tsc` clean; `npm audit` clean; `.mjs` tests 68 pass; extension `npm run check` green with 93 tests.
Tests for everything below that was not fixed are in `tasks/bug-hunt-proofs.md`.
Baseline: `npm test` 1106 tests, 1104 pass, 2 skipped, 0 fail; `tsc` clean; `npm audit` clean; `.mjs` tests 67 pass; extension 87 pass; main CI green on f5ce68e, including the nightly full iOS UI suite.

Tiers: **proven** = a failing test was run, or the fact is mechanically checkable; **likely** = reasoned from the code, not run; **decision** = intentional-looking, a tradeoff, or pinned by an existing test.

## Fixed
Each has a test that failed before the fix, and fails again with the fix reverted.

Worker ingest
- Feed titles and bylines kept `&#8217;` and `&#038;` verbatim (the form WordPress emits); a repeated element such as two `dc:creator` dropped the field; discovery cut `/?feed=rss2&#038;cat=3` at the `#` and decoded every href twice. Only display fields are decoded: guids, links and bodies are untouched, and item identity is unchanged across the 62-document corpus. Existing rows keep their old titles. Tests in `feed-parser.test.ts`, `feed-discovery.test.ts`.
- A List-Id with no ASCII letters or digits produced the feed key `''`; an RFC 2047 encoded List-Id was stored raw as the feed name; a forwarded email whose subject was only `Fwd:` was stored with an empty subject (which fails the iOS sync page); every email from a known sender wrote a no-op feed sync row. Tests in `email-integrity.test.ts`.
- Feeds in a declared non-UTF-8 charset became mojibake. Valid UTF-8 always wins over a declared charset, so a UTF-8 feed with a wrong header is unaffected. Tests in `feed-network.test.ts`.
- A 302/303/307 redirect replaced the stored `source_url`, so a signed or expiring target broke the feed for good. Refresh, discovery and subscribe now store only the permanent URL, as source, canonical and alias. Two entries with one guid overwrote each other on every changed poll. Tests in `rss-refresh-redirects-duplicates.test.ts`, `feed-discovery.test.ts`.

Worker API
- ClientLogin threw on JSON, text or empty POSTs (the one unauthenticated route); mark-all-as-read rewrote and loaded every row in the stream, read or not; the status mutation scanned all of `item_statuses` for want of an `account_id` predicate. Tests in `write-path-costs.test.ts`.

Web reader
- "Save library offline" could never succeed: `/app` has been served `Cache-Control: private` since b2f9fa5 and the service worker refuses private responses. Now `no-cache`. **This changes two existing header assertions in `browser-app.test.ts`.** Live production shows the broken header today. Test in `browser-service-worker.test.ts`.
- A 5xx from `/app/status` (or a network failure) during session restore discarded a valid token. Test in `browser-app-client-shell.test.ts`.
- Reading position was not restored when the body loaded after the article opened. Test in `browser-app-client-reader.test.ts`.

Extension
- One queued save never backed off while Pigeon was unreachable; a flush re-sent a save that had finished meanwhile; a flush that threw left the queue with no retry alarm; sign-out and settings errors were written into a hidden form. Tests in `retry.test.ts`, `save.test.ts`, `manifest.test.ts`.

Release tooling and hygiene
- `app-store-connect-verify.mjs` returned its default timeout and poll interval in seconds where milliseconds are expected (900 ms, 15 ms) when the env vars are unset; `npm run test:testflight` ran one of three `.mjs` test files.
- Untracked two `.pyc` files, ignored `__pycache__/` and `HANDOFF.md`; removed `parseRssFeed`, `tokenOverlapSimilarity` and `clearMonitoredTopics` (no references); README schema version 13 to 16, Readwise and Safari facts.

## iOS: nothing fixed, nothing verified
The iOS auditors read the code but were told not to build. When it was time to run their tests the shared Mac had a load average above 600, two CI runners working and more iOS jobs queued, so no local simulator run was started. Every iOS item below is therefore unrun; the tests are written out in `tasks/bug-hunt-proofs.md`. One server-side cause is fixed already (the empty forwarded subject).

## Not fixed: needs you

### Act on first
1. **Fork PRs can run code on the laptop runner** (proven). The repo is public, fork-PR approval is `first_time_contributors`, and the fork guard at `.github/workflows/ci.yml:153` lives in the workflow file, which a fork PR can edit. Anyone with one merged PR needs no approval. The `testflight` environment has no protection rules or branch policy. `docs/testflight-release.md:56` still says the repo is private. Fix is in GitHub settings: require approval for all external contributors, restrict `testflight` to `main`.
2. **Removing a saved item frees its reader id for the next article** (proven, `src/mutation-api.ts:310`). `items` has no AUTOINCREMENT, so after `remove_saved` the next ingested article gets the same rowid. A queued star or read aimed at the removed item lands on the new article. Fix touches every item INSERT or the schema.
3. **iOS: a sync merge or a new preparation drops user actions** (likely, `ReaderAppModel.swift:8187-8193, 7185-7194, 4980-4997, 8052`). Mutations are guarded by `libraryGeneration` and `activeOfflinePreparationID`, both of which change on every sync merge and every scene activation. A toggle queued behind another is discarded, Mark All on a folder returns silently, `bulkReadUndo` is set before anything is queued.
4. **iOS: any sync that delivers changes clears an in-progress search** (proven by code, found independently by two auditors, `ArticleListView.swift:441-443, 509-512`). `loadRequestKey` includes `libraryGeneration`; the rerun sets `searchText = ""`. Fix: delete `:510-512`; `.id` already resets search per collection.
5. **iOS: adding a topic while Personalization reloads deletes the existing topics** (likely, `PersonalizationSettingsView.swift:150, 209-212`). The view seeds `monitoredTopics = []` on re-entry and Add sends only the new topic.

### Worker ingest
- **Jitter above 1.0 with an hourly cron puts about half of 60-minute feeds on a 2-hour cadence** (proven, `src/refresh-policy.ts:49-51`). 518 of 1,000 simulated feeds were late. Related **throughput ceiling**: `REFRESH_LIMIT = 5` per hourly tick means N RSS feeds refresh about every N/4 hours.
- **Oldest-first feeds with more than 50 entries never deliver new posts** (proven, `src/rss-fetcher.ts:405`, `src/subscribe.ts:277`). The poll takes the first 50 in document order.
- **Guid-less items sharing one link collapse into one row** with the title of one and the body of another (proven, `src/rss-fetcher.ts:409-411, 782`).
- **RSS bodies are trimmed by the email normaliser** (proven, `src/rendered-content.ts:332-388`). An RSS body containing `class="main-content"` loses everything outside that element in `/feed/:key` and GReader `stream/contents`.
- **Every successful RSS refresh writes a no-op feed sync row** (proven, decision). `trg_sync_feed_update` fires on any UPDATE that names `site_url` or `source_url`, and the refresh UPDATE always names both. Feed events are never compacted and iOS redoes per-feed work for each. A code-side fix collides with five tests that pin the UPDATE's bind order and write semantics; the clean fix is a `WHEN OLD.x IS NOT NEW.x` clause on the trigger at the next schema bump. The email path is fixed.
- **A slow feed can starve behind `budget_deferred`** (likely, `src/rss-fetcher.ts:715-725`).
- **`/feed/:key` and GReader contents have no byte bound** (likely, `src/feed.ts:69-93`, `src/greader.ts:766-902`). 50 x 100 KB bodies took 281 ms locally against a 10 ms CPU budget.
- Decisions: title edits never propagate (`subject` absent from the upsert SET); future `pubDate` values are accepted and pin to the top; `items.content_size` is write-only; `Cache-Control: max-age` can stretch a 60-minute feed to 24 hours (pinned).

### Worker API
- **`/app/status` reads the whole database** (proven, `src/status.ts:112-119`): 45,015 of 45,733 pages in a 3,000-item benchmark, against 52 from covering indexes. Nine sequential queries.
- **Sync size probe loads up to 200 full bodies per page** (proven, `src/sync-api.ts:159`). `octet_length` would avoid it; needs SQLite 3.43 on D1.
- **Atom 304 path reads the bodies anyway** (proven, `src/index.ts:213-216`).
- **Web-push lookup walks every article event** (likely, `src/web-push.ts:179-185`).
- **Engagement ingestion fails the whole batch on one missing item** (likely, `src/engagement.ts:250-253`).
- **A queued status mutation for a removed saved item fails forever** (decision, pinned by two tests; `src/mutation-api.ts:350-352`). iOS never drops it and stops replay after a failing page; seven block the queue.
- Decisions: a no-op status mutation still appends a sync event (pinned); `/feeds` and `/feeds/opml` list every feed key without auth; legacy missing-table fallbacks in `greader.ts` are unreachable (pinned by three tests); ClientLogin has no rate limit; `browser_push_subscriptions` is created outside the versioned schema; `mutation_receipts` is never pruned.
- `src/item-transcripts.ts:19-22` documents 8,000 segments and 300 chapters; the constants at `:45-46` are 2,000 and 200. Both were changed in the same commit (a71b59f), so which one is intended is yours to say.
- Schema leftovers for the next bump: table `parsing_rules` and column `engagement_events.metadata_json` are unread; `idx_sync_changes_sequence`, `idx_items_message_id`, `idx_mutation_receipts_applied` are redundant.

### Web reader
- **One failed request latches offline mode until reload** (proven, `src/browser-app.ts:1546-1547, 4611`).
- **Mark all as read downloads every body in the stream** (proven, `src/browser-app.ts:4663-4721`): 3 unread among 400 fetched 400 bodies in 20 requests.
- **Filtered views re-download every body on each revalidation** (proven, `src/browser-app.ts:3848-3853`, `src/browser-library-api.ts:111-124`): the ids endpoint carries no `contentVersion`.
- **One pending-mutation slot drops actions** (proven, `src/browser-app.ts:4580, 4871`): J pressed three times with mark-on-open marked two of four.
- **List render re-strips full bodies on every render** (proven, `src/browser-app-client.ts:742-764`): 156 ms per render for 200 rows of 60 KB.
- **Offline library scans the whole store per id** and saves a reading position nothing reads (proven, `src/browser-offline.ts:133-136`).
- Likely: first page asks for 50 bodies in one response with no fallback; `?article=` survives confirm and cancel (`browser-app.ts:1607, 1617`); `notificationPanel.refresh()` errors are swallowed; YouTube search outage text never shows (`browser-library-management.ts:286-288`); stale reader chrome in two `renderReader` branches.
- Decisions: `docs/web-feature-parity.md` claims Readwise and working offline; YouTube player hidden unless image policy is `load`; manifest `theme_color` differs from the shell meta by one digit.

### Extension
- **Extraction from another page is stored under the clicked URL** when the tab navigates before injection (proven at function level, `extension/src/core/save.ts:59-70`).
- **Double click sends the page twice** (proven, `extension/src/background/index.ts:94-103`).
- **A result shown without a tab id sticks on the global badge** (proven, `extension/src/core/badge.ts:46`).
- **Safari: context menu items probably vanish after Safari restarts** (likely, `extension/src/background/index.ts:34-41`); menus are created only in `onInstalled`.
- Decisions: no-access retries never back off (pinned); a 404 from the save endpoint queues forever; `tabs.onRemoved` wakes the worker on every tab close; the Safari CI job skips `manifests/safari.json` and `build.mjs` changes (pinned).

### iOS Core
- **`contentVersion` is never persisted** (proven by grep: 0 occurrences in `OfflineLibraryStore.swift`), so after a cold launch the first load of each collection refetches every body.
- **Sanitizer may drop the rest of an article after a void blocked tag** such as `<source>`, `<input>`, `<meta>` (likely, `StructuredHTMLSanitizer.swift:73-79`).
- **An article with an empty title fails every sync page containing it** and loops through full rebuilds (likely, `OfflineLibraryStore.swift:1308-1316`). The Worker no longer produces one from a forwarded email, but a row stored earlier would still do it; check with `SELECT COUNT(*) FROM items WHERE subject = ''`.
- **A pending star on a Read It Later item bumps Unread and Today counts** (likely, `OfflineLibraryStore.swift:1659-1703`).
- **A mutation the server can never apply is retried forever** (likely, `OfflineMutationReplayer.swift:152-162`).
- **Reader View decodes every page as UTF-8** (likely, `ReaderViewExtractor.swift:57`).
- Inefficient (proven by code): every enqueue and acknowledgement decodes every cached article (`OfflineLibraryStore.swift:1601-1622`); each feed sync event redoes per-feed reconcile and a navigation rebuild (`:1196-1210, 2083-2145`); regexes compiled per tag in the sanitizer (`StructuredHTMLSanitizer.swift:172, 258`); two `ISO8601DateFormatter`s per decoded date (`PigeonAPIClient.swift:735-755`).
- Decisions: images are inserted before the privacy policy is applied (`StructuredHTMLJavaScript.swift:408-411`, needs a device check); out-of-order replay after a failure (pinned); Today count includes the last second of yesterday (pinned); no deadline on a Reader View extraction session.

### iOS app model and platform
- **Background refresh cannot stop at expiration** (proven by code, `BackgroundRefreshManager.swift:151-159`): the handler cancels a task that is parked on work that does not observe cancellation, so `setTaskCompleted` waits for the sync.
- **Read It Later open makes every foreground refresh show "Offline"** (likely, `ReaderAppModel.swift:1260-1272, 2866-2868`).
- **Undo of a bulk read over-counts** after one story was restored by hand (likely, `ReaderAppModel.swift:8131-8141`).
- **Stale-feed Undo is re-entrant** (likely, `ReaderAppModel.swift:3622-3669`).
- **A case-only folder rename is rejected** (likely, `ReaderAppModel.swift:3826`): the duplicate check matches the folder being renamed.
- **Lifecycle failure detection compares against a stamp that `force` just erased** (proven by code, `ReaderAppModel.swift:1241-1248, 1847-1850`).
- Inefficient (proven by code): a restoration save on every 1% of scroll with a payload that never shrinks (`ReaderAppModel.swift:1838-1843`); every scene activation runs a full sync and fetches the open list twice (`:1118-1129, 1242, 1260`); each read or star toggle rewrites whole collections and blocks the next toggle (`:8190, 7523-7556`).
- **Privacy manifest declares no accessed APIs** though 12 files use `UserDefaults` (proven, `PrivacyInfo.xcprivacy:22-23`); neither extension target has a manifest.
- Decisions: BG refresh handler is wired only from `ReaderShellView.task`, possibly nil on a cold background launch; a 401 has no expired-session state; share-extension "Add as Feed" relies on `extensionContext.open`; `SceneBackgroundTaskRunner` hops through a Task inside the expiration handler.

### iOS views and UI tests
- **⌘S is bound to two actions on the reader screen** (proven by code): Star at `ArticleReaderView.swift:240` and "More like this" at `ArticleReaderControlsBar.swift:347`, both mounted together. ⌘, is registered three times with one action.
- **Tapping a link records an outbound click before the user chooses** (proven by code, `ArticleBodyView.swift:299-304`).
- **Menu Refresh and pull-to-refresh behave differently** (proven by code, `ArticleListToolbar.swift:103-105`).
- **Article web view never recovers from WebContent process termination** (likely, `StructuredHTMLView.swift`; no `webViewWebContentProcessDidTerminate`).
- **Website mode: Safari's Done button does nothing** (likely, `ArticleWebsiteView.swift:9`).
- Likely: saved position not restored after a boundary-pull navigation; a second OPML file chosen mid-import loses its preview; a body change while reading re-records the open; Add Feed Cancel stays enabled while saving.
- Inconsistent: Front Page has no Read It Later action and Classic has it only as a swipe; the Settings Layout picker shows on iPad where nothing reads it; identifier `add-feed` is on two buttons; article HTML is sent to the web view twice as its own signature (`StructuredHTMLView.swift:337-339`).
- UI tests: `testSyncHealthShowsFeedDiagnosticsAndManualRetry` cannot fail on the retry; two pairs of duplicate tests (`:1118`/`:1173`, `:324`/`:368`); negative assertions on strings that exist nowhere (`:749-761`); two iPad-only tests are always skipped because CI selects only iPhones, so the nightly runs 77 of 79.

### CI, release, docs
- **Simulator reservations are never reclaimed** (proven, `.github/scripts/ios-simulator-session.py:60-65`): one stale lock sends jobs to the shared `iPhone 17 Pro`, then to other repos' simulators.
- **Release verify job queues behind iOS CI for the one runner** (proven, `release-testflight.yml:541-545`): 48 minutes of waiting for 12 seconds of work.
- **Stale release state file** (likely, `scripts/release-new-build-to-testflight.mjs:91-97`): the documented fixed path makes a second release refuse, and `--resume-monitor` then reports the previous release as success.
- **Cleanup failure after upload strands the build** (likely, `release-testflight.yml:520-540`).
- **Scope filter runs the iOS job for non-app paths**: `04-storage/SCHEMA.sql`, `VERSION`, `tasks/*.md`, `09-*`/`10-*`, `wrangler*.toml`, `tsconfig.json` (proven, `.github/scripts/ci_scope.py:29-36, 69-75`). It also names a `migrations/` directory that does not exist.
- **The same commit is tested four times around a release** and the reuse path is unreachable because the changelog PR always makes a new merge commit (proven for c89bb2a).
- **"Nightly 08:00 UTC" actually starts 14:29 to 17:57 UTC**; two of seven runs lost the runner 10 minutes in.
- Smaller: the gate inspects only 20 runs, so an unchanged main reruns the full suite about every 21 days; the runner lock's age rule replaces a live holder after 3 h; main-health treats every dispatch as full-suite; monitor timeout is shorter than the workflow; `test_ios_simulator_session.py` prints `::warning::` on every run and runs twice; `.github/actionlint.yaml` is referenced by nothing and `actionlint` exits 1 today.
- Docs (README facts are fixed; these remain): `CLAUDE.md` says to test email with saved `.eml` fixtures (none exist), calls the numbered folders historical though 22 test files load `04-storage/SCHEMA.sql`, and says 77 UI tests (79, 2 skipped); `CHANGELOG.md` has two Unreleased sections (`:5`, `:91`) and no 0.1.4.0; `04-storage/MIGRATIONS.md:12` documents v13 (code is v16); `docs/testflight-release.md:73, 95` have leftover text. `AGENTS.md` is in flight in PR #174.

## No longer needed (not removed: each is test-referenced or a document)
- Worker, used only by their own tests: `isProbablyFeedContent`, `detectFeedFormat`, `selectDiverseRecommendations`, `matchMonitoredTopics`, `clearYouTubeChannelSearchCache`, `WORD_COUNT_SOURCE_LIMIT`, the `hubUrl` option (`src/feed.ts:57`), the `fromAddress` option and its +80 bonus (`src/original-url.ts`), the `extractOriginalUrl` alias, the unread and starred recommendation views (`src/recommendations.ts:623-632, 709-736`).
- Web: `limitInitialItemIds` and `createContentLoadPlan` are emitted but throw `ReferenceError` in the page and nothing calls them; `getNavigationDirectionFromKeyEvent` always returns 0; `/api/v1/browser/readwise/save` and `src/readwise-token-api.ts` have no caller since build 3901; `/app/icon.png` is referenced nowhere; CSS `.primary-button`, `.menu-row`, `.menu-heading`, `[data-icon="refresh"]`, icons `refresh` and `folder`, the radio rules.
- iOS, no reference at all: `Core/ReaderDestination.swift`, `ReaderLocalDayBounds.endSeconds`, `ReaderBoundaryPullPhase.idle` and `reset()`, `ReaderFeedThumbnailMemoryCache.removeAll(where:)`, `SavedExtractionCoordinator.attemptCount`, `ReaderArticleFilterStore.defaultFilter`, `isLoadingNavigation`/`isLoadingLibrary` (written, never read), `unfiledSubscriptions`, `isLoading`, the `findQuery` chain, `onBackSwipe` on the boundary recognizer, two unreachable `onChange` handlers. Test-only: `Core/ArticleContentFormatter.swift`, `PigeonAPIClient.updateItemState`/`streamContents`, `ArticleReaderReadingAdjustment`, `selectNextUnread`, and about ten more listed in the auditor reports.
- iOS scripts: `ios/PigeonReader/scripts/SidebarProjectionBenchmark.swift` traps on its own precondition; `ArticleImageDiscoveryBenchmark.swift` and `benchmark-sidebar.py` are referenced only by the iOS README.
- `LegacyReadwiseCleanup` is still needed until every device has launched build 3901 once (added 2026-11-03).
- Documents describing finished work: `tasks/p0-p2-roadmap.md` (104 of 104 checked), most of `tasks/todo.md`, `docs/web-feature-parity.md`, `docs/superpowers/plans/*`; `04-storage/SCHEMA-V6/7/8.sql` are referenced by nothing.
- Git: 30 remote branches are fully merged into `main`.

## Review
- Red check: 10 of 10 fix commits go red when the fix is reverted and the test kept (run in a scratch worktree per commit). The chore commit has no behaviour test.
- One fix changed existing assertions: the `/app` cache header (two lines in `browser-app.test.ts`). One fix edited a fake database's SQL strings to match (`greader-compat.test.ts`, four literals, no assertion changed).
- Dropped after trying: conditional `site_url`/`source_url` in the RSS refresh UPDATE (five existing tests pin it; listed above as a decision).
- Not attempted: all iOS work, for the reason above. Nothing under `ios/` changed except two README sentences.
- Auditor reports not acted on because the evidence was thin: none were contradicted by a test. The iOS items are the unverified ones.
- Code review of the branch before pushing found ten issues, all fixed in four `fix(review)` commits. The two that mattered: decoding entities parser-wide would have changed the identity of stored articles whose guid contains `&#038;` (duplicates after deploy), and trusting the header charset would have broken UTF-8 feeds served with a legacy default.
- After the review fixes: `npm test` 1140 tests, 1138 pass, 2 skipped; extension 93 tests.
