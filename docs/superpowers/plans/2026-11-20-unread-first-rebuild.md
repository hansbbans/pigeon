# Unread-first offline rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full offline rebuild on iOS lists unread, starred, saved and recently read article metadata in seconds, downloads bodies in a resumable background queue, and never blocks pull-to-refresh.

**Architecture:** Two new native Worker endpoints: a keyset-paginated metadata listing that pins a `/api/v1/sync` cursor, and a budget-trimmed article fetch by ID. On iOS the rebuild writes listing pages into the existing staging generation (resumable through `cache_rebuilds`), promotes it with the existing swap, then a persisted fetch queue fills bodies. Refresh stops awaiting rebuilds, and sync pages skip unapplicable changes instead of forcing a rebuild.

**Tech Stack:** Cloudflare Worker (TypeScript, D1, `node:test` + `tsx` with in-memory SQLite), iOS SwiftUI app (Swift Testing, SQLite via the C API in `OfflineLibraryStore`).

**Spec:** `docs/superpowers/specs/2026-11-20-unread-first-rebuild-design.md`

## Global Constraints

- Worker: TypeScript strict, ESM, Web APIs only in `src/`; D1 multi-statement writes through `DB.batch()`; no no-op writes to `items`; never delete `sync_changes` rows.
- Every new endpoint stays under the 10 ms Free-plan CPU budget: bound by bytes, reuse `SYNC_PAGE_BODY_BUDGET` (192,000 characters) for bodies.
- API changes are additive. `/api/v1/sync` and every existing response shape stay byte-identical (contract fixtures prove it); TestFlight 4401 keeps working.
- The listing returns unread, starred, Read It Later (`source_type = 'saved'`), and read articles with `received_at` within the last **7** days.
- Body queue order: unread first, newest `received_at` first, then starred and saved.
- iOS falls back to the existing full change-log replay only when `/api/v1/library` answers **HTTP 404** (older Worker). Any other failure is a normal sync failure.
- iOS tests: `Pigeon Claude` simulator, `-parallel-testing-enabled NO`, `xcodegen generate` after adding files. Never `simctl shutdown all`, never `gh run cancel` an iOS job.
- Worker checks: `npm test`, `npm run typecheck` (full gate `npm run check`).
- Ship together at the end: Worker deploy first, then one TestFlight release.

## Review Focus

1. **An interrupted rebuild resumes, not restarts:** killing the app after listing page 2 of 5 and relaunching requests page 3's continuation. Pinned in Task 5 (`resumedRebuildContinuesFromTheSavedListingContinuation`) and Task 6 (`interruptedListingRebuildResumesFromItsContinuation`).
2. **Bodies already on the phone survive the swap:** an unread article whose body was downloaded before the rebuild still has it afterwards, so the queue does not refetch it. Pinned in Task 4 (`promotionKeepsCanonicalBodiesForEveryListedArticle`).
3. **Pull-to-refresh returns while a rebuild is running:** Task 7 (`pullToRefreshReturnsWhileARebuildIsStillListing`).
4. **The queue never spins on an article the server no longer has:** an ID reported `missing` is not requested again. Task 4 (`unavailableArticlesLeaveTheFetchQueue`) and Task 8 (`missingArticlesAreNotRequestedTwice`).
5. **A pending local read survives the swap:** an article marked read offline, with the mutation not yet acknowledged, is still read after the listing rebuild promotes. Task 5 (`pendingLocalReadSurvivesAListingRebuild`).

---

### Task 1: Worker metadata listing `GET /api/v1/library`

**Files:**
- Modify: `src/sync-api.ts` (extract payload builders; no behaviour change)
- Create: `src/library-api.ts`
- Modify: `src/native-api.ts` (route), `src/index.ts` (add `/api/v1/library` and `/api/v1/library/articles` to the native path list)
- Test: `test/library-api.test.ts` (uses `test/helpers/sqlite-d1.ts`), `test/api-contract.test.ts`, new fixture `test/fixtures/api-contract/library.response.json`

**Interfaces:**
- Produces (exported from `src/sync-api.ts`):
  - `export async function loadFeedPayloads(env: Env, feedKeys: string[] | 'all'): Promise<FeedPayload[]>`; payload exactly as sync's feed payload today (sorted folders).
  - `export async function loadArticlePayloads(env: Env, ids: string[], options: { includeBody: boolean }): Promise<Map<string, ArticlePayload>>`. With `includeBody: false` the SQL must not select `html_content`/`text_content`, and the payload omits `html`, `text` and `isPaywalled` (all body-derived); every other field is identical to sync's.
  - `export interface FeedPayload`, `export interface ArticlePayload` (the current inline object shapes).
  - `handleIncrementalSync` uses both; `sync.response.json` must not change.
- Produces (`src/library-api.ts`):
  - `export const LIBRARY_DEFAULT_LIMIT = 200; export const LIBRARY_MAX_LIMIT = 500; export const LIBRARY_RECENT_READ_DAYS = 7;`
  - `export async function handleLibraryListing(request: Request, env: Env, now?: Date): Promise<Response>`
  - Query: `continuation` (optional, opaque `l1:<snapshotSequence>:<afterRowid>`), `limit`.
  - Response: `{ snapshotCursor: string /* "v1:<n>", same format as sync */, continuation: string | null, feeds: FeedPayload[] /* all feeds on the first page, [] after */, articles: ArticlePayload[] /* metadata only */ }`.
  - First page reads `COALESCE(MAX(sequence), 0)` from `sync_changes` before selecting rows. Articles: `items JOIN feeds`, `i.rowid > afterRowid AND (i.is_read = 0 OR i.is_starred = 1 OR f.source_type = 'saved' OR i.received_at >= <now − 7 days ISO>) ORDER BY i.rowid LIMIT limit + 1`.
  - Malformed continuation → 400 `{ error }`, like `decodeCursor`.

- [ ] **Step 1: Write the failing tests** in `test/library-api.test.ts`:
  - `listing returns unread, starred, saved and recent read articles but not old read ones`: seed one feed + saved feed, items: unread old, read old (received 30 days before `now`), read recent (2 days), starred read old, saved read old. Assert the returned `id` set equals all but "read old"; `feeds.length === 2`.
  - `listing pages are keyset ordered, carry one snapshot cursor, and end with a null continuation`: 5 matching items, `limit=2` → 3 pages; ids strictly increasing by rowid across pages, no duplicates; every page's `snapshotCursor` equals `v1:<max sequence before page 1>`; insert a new unread item between page 1 and 2 and assert `snapshotCursor` on page 2 is unchanged; last page `continuation === null`; `feeds` empty after page 1.
  - `listing article payloads carry no body fields`: assert `html`, `text`, `isPaywalled` are `undefined`, and `title`, `receivedAt` (ISO `...Z`), `isRead`, `isStarred`, `readerId` match the sync payload for the same item.
  - `listing rejects a malformed continuation`: `continuation=bogus` → 400.
  - In `test/api-contract.test.ts`: `library listing page` → `assertMatchesFixture(await state.request('/api/v1/library?limit=200'), 'library.response.json')`.
- [ ] **Step 2: Run** `npx tsx --test test/library-api.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** the `sync-api.ts` extraction, then `library-api.ts`, then routing (`native-api.ts`: `if (path === '/api/v1/library' && request.method === 'GET') return handleLibraryListing(request, env);`).
- [ ] **Step 4: Run** `npx tsx --test test/library-api.test.ts test/sync-api.test.ts` → PASS; then `UPDATE_CONTRACT_FIXTURES=1 npx tsx --test test/api-contract.test.ts` once to create `library.response.json`, inspect it (no `html`), then rerun without the variable → PASS, and `git diff test/fixtures/api-contract/sync*.json` is empty.
- [ ] **Step 5: Commit** `feat(api): metadata listing for an unread-first offline rebuild`.

### Task 2: Worker article fetch `POST /api/v1/library/articles`

**Files:**
- Modify: `src/library-api.ts`, `src/native-api.ts`
- Test: `test/library-api.test.ts`, `test/api-contract.test.ts`, fixtures `library-articles.request.json`, `library-articles.response.json`

**Interfaces:**
- Consumes: `loadArticlePayloads(env, ids, { includeBody: true })`, `SYNC_PAGE_BODY_BUDGET`.
- Produces: `export const LIBRARY_ARTICLES_MAX_IDS = 50; export async function handleLibraryArticles(request: Request, env: Env): Promise<Response>`.
  - Request JSON `{ "ids": string[] }`, 1…50 entries, else 400.
  - Response `{ articles: ArticlePayload[] /* full, with html/text/isPaywalled, in request order */, missing: string[] /* requested ids with no item row */ }`.
  - Trimming: walk requested ids in order summing `LENGTH(html_content) + COALESCE(LENGTH(text_content), 0)`; stop before the first article that would exceed the budget, except the first article is always included. Ids neither returned nor missing are simply absent (client re-requests them).

- [ ] **Step 1: Failing tests:** `article fetch returns full payloads in request order`; `article fetch reports ids with no item as missing`; `article fetch trims to the body budget but always returns the first article` (three items whose html + text total `0.4 × SYNC_PAGE_BODY_BUDGET` each → first two returned, third absent and not in `missing`; one item of `2 × SYNC_PAGE_BODY_BUDGET` alone → returned); `article fetch rejects an empty list and more than 50 ids` (400). Contract test: `library article fetch` posts `library-articles.request.json` and matches `library-articles.response.json`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** and route `POST /api/v1/library/articles`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` → PASS (regenerate the new response fixture once as in Task 1).
- [ ] **Step 5: Commit** `feat(api): fetch article bodies by id within the page body budget`. Push; open **PR 1 (Worker)** with both tasks; on green CI and review, merge (not deployed yet).

### Task 3: iOS API client for the listing and article fetch

**Files:**
- Modify: `ios/PigeonReader/PigeonReader/Core/OfflineLibraryModels.swift`, `Core/PigeonAPIClient.swift`
- Test: `PigeonReaderTests/Core/APIContractTests.swift`, `PigeonReaderTests/Core/PigeonAPIClientTests.swift`

**Interfaces:**
- Produces:
  - `nonisolated struct LibraryListingPage: Codable, Equatable, Sendable { let snapshotCursor: String; let continuation: String?; let feeds: [IncrementalSyncPayload]; let articles: [IncrementalSyncPayload] }`
  - `nonisolated struct LibraryArticlesResponse: Codable, Equatable, Sendable { let articles: [IncrementalSyncPayload]; let missing: [String] }`
  - `func libraryPage(continuation: String?, limit: Int = 200) async throws -> LibraryListingPage` (GET `api/v1/library`)
  - `func libraryArticles(ids: [String]) async throws -> LibraryArticlesResponse` (POST JSON `{"ids":[…]}`, `Content-Type: application/json`)
  - Non-2xx surfaces as the existing `PigeonError.server(statusCode, …)`, so callers can match 404.

- [ ] **Step 1: Failing tests:** `libraryFixtureDecodesMetadataOnlyArticles` (decodes `library.response.json`: `snapshotCursor` matches `^v1:\d+$`, feeds non-empty, every article `html == nil`); `libraryArticlesRequestMatchesTheContract` (encoded body equals `library-articles.request.json`, decodes the response fixture, `articles.first?.html` non-empty); in `PigeonAPIClientTests`, `libraryPageSendsContinuationAndLimit` (query `continuation`, `limit=200`) and `libraryPageSurfacesA404AsServerError`.
- [ ] **Step 2: Run** `xcodebuild test … -only-testing:PigeonReaderTests/APIContractTests -only-testing:PigeonReaderTests/PigeonAPIClientTests` → FAIL (compile).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same → PASS.
- [ ] **Step 5: Commit** `feat(ios): API client for the library listing and article fetch`.

### Task 4: iOS store — fetch queue, body state, repair in place, and body-preserving promotion

**Files:**
- Modify: `Core/OfflineLibraryStore.swift`, `Core/OfflineLibraryModels.swift` (protocol + no-op defaults)
- Test: `PigeonReaderTests/Core/OfflineLibraryStoreTests.swift`

**Interfaces:**
- Schema (in `createSchema`, plus a guarded `ALTER TABLE` like `migrateCacheRebuildIntents`):
  - `cached_articles.body_missing INTEGER NOT NULL DEFAULT 0`, written by `writeArticle`: `1` when the stored article has no readable HTML and `bodyPruned == false`, else `0`.
  - `CREATE TABLE IF NOT EXISTS article_fetch_queue (account_id TEXT NOT NULL, article_id TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY (account_id, article_id))`.
  - `cache_rebuilds.listing_continuation TEXT` (used by Task 5; add here with the other schema changes).
- Produces (`OfflineLibraryStoring`, defaults no-op / empty for test doubles):
  - `func articleIDsNeedingFetch(accountID: String, limit: Int) async throws -> [String]`: committed account only; first `article_fetch_queue` rows (oldest first), then `body_missing = 1 AND (is_read = 0 OR is_starred = 1 OR feed_key = SavedItems.feedKey)` ordered `is_read ASC, received_at DESC`.
  - `func applyFetchedArticles(_ articles: [IncrementalSyncPayload], accountID: String, dayBounds: ReaderLocalDayBounds?) async throws -> [Recommendation]`: one transaction; existing row → fill `html`/`text`/`isPaywalled` only if it has no readable HTML (never change read/starred); absent row → insert through the same path as a sync article upsert (memberships rebuilt, pending overlays applied); delete the ids from `article_fetch_queue`; return the stored articles.
  - `func markArticlesUnavailable(ids: [String], accountID: String) async throws`: delete from the queue and set `body_missing = 0`.
- Behaviour change in sync `apply` (status case and malformed changes):
  - Status for an article not in the store: skip it; if its payload has `isStarred == true`, insert the id into `article_fetch_queue`. No throw.
  - A malformed feed/article/status change: skip it and add 1 to the page's integrity `invalidChangeCount`. No throw. Existing tests asserting that a malformed change fails the page are updated to assert skip + count.
- `preserveCanonicalArticleBodies`: drop the For You join; carry the canonical body to every staged article (matched by id or reader id) that has no readable HTML, whether `body_pruned` or `body_missing`.

- [ ] **Step 1: Failing tests:**
  - `statusForAMissingArticleIsSkippedInsteadOfFailingThePage`: apply a page with one valid article and one status for an unknown id → no throw, cursor saved, article stored.
  - `starredStatusForAMissingArticleQueuesItForFetch`: → `articleIDsNeedingFetch` returns that id.
  - `malformedChangeIsSkippedAndCounted`: article change with empty title → no throw, `storageStats.invalidChangeCount`… (read via `loadSnapshot(...).integrity.invalidChangeCount`) increments by 1.
  - `fetchQueueOrdersUnreadNewestFirstThenStarred`: three body-missing articles (unread new, unread old, read starred) + one read unstarred → `["unread-new", "unread-old", "starred"]`.
  - `applyingFetchedArticlesFillsBodiesWithoutChangingReadState`: stored unread body-missing article, local read applied; fetched payload says `isRead: false` with html → html filled, still read, no longer in `articleIDsNeedingFetch`.
  - `unavailableArticlesLeaveTheFetchQueue`.
  - `promotionKeepsCanonicalBodiesForEveryListedArticle`: canonical article with body (not in For You); rebuild stages it without html; finish → committed article still has the body and is not in the fetch queue.
- [ ] **Step 2: Run** `-only-testing:PigeonReaderTests/OfflineLibraryStoreTests` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `OfflineLibraryStoreTests` and `ReaderAppModelTests` → PASS (update the malformed-change assertions noted above, nothing else).
- [ ] **Step 5: Commit** `feat(ios): repair sync pages in place and queue missing article bodies`.

### Task 5: iOS store — resumable listing rebuild

**Files:**
- Modify: `Core/OfflineLibraryStore.swift`, `Core/OfflineLibraryModels.swift`
- Test: `PigeonReaderTests/Core/OfflineLibraryStoreTests.swift`

**Interfaces:**
- Produces:
  - `func beginOrResumeFullRebuild(accountID: String, at date: Date, maxAge: TimeInterval = 24 * 60 * 60) async throws -> String?`: if a `cache_rebuilds` marker exists with non-null `listing_continuation` and `created_at` within `maxAge`, re-attach it (`stagingAccountIDs[accountID] = stagingID`) and return the continuation; otherwise behave exactly like `beginFullRebuild` and return `nil`. `beginFullRebuild` stays for the legacy replay.
  - `func applyLibraryListingPage(_ page: LibraryListingPage, accountID: String, dayBounds: ReaderLocalDayBounds?) async throws`: requires an attached staging generation (else `invalidCacheState`). In **one** transaction: convert `feeds` then `articles` to `IncrementalSyncChange` upserts (sequence 0, `changedAt` now) and apply them through the existing private `apply(_ change:…)`; write `sync_state.cursor = page.snapshotCursor`; set staged integrity `lastPageHasMore = (page.continuation != nil)`; set `cache_rebuilds.listing_continuation = page.continuation ?? ""` (empty string means listing finished; still resumable to the navigation step).
  - `beginOrResumeFullRebuild` treats `listing_continuation = ''` as resumable too and returns `""`; the caller then skips straight to navigation and promotion.

- [ ] **Step 1: Failing tests:**
  - `listingPagesBuildAStagedLibraryThatPromotes`: begin, apply two pages (second `continuation: nil`), save navigation, `finishSynchronization` → committed snapshot has the listed articles, `cursor == snapshotCursor`, integrity `.complete`.
  - `resumedRebuildContinuesFromTheSavedListingContinuation`: begin, apply page 1 (`continuation: "l1:9:3"`), create a **new** `OfflineLibraryStore` on the same database file (simulates relaunch), `beginOrResumeFullRebuild` → returns `"l1:9:3"`, page-1 articles still staged, committed library untouched.
  - `staleRebuildMarkerStartsOver`: same, with `maxAge: 0` → returns `nil` and the old staged rows are gone.
  - `aMarkerWithoutListingProgressStartsOver`: marker from legacy `beginFullRebuild` → `nil`.
  - `pendingLocalReadSurvivesAListingRebuild`: store holds article X unread; `enqueue` a `set_read` mutation for X (not acknowledged); begin, apply a listing page with X `isRead: false`, save navigation, finish → committed X is read and still in the pending outbox.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `OfflineLibraryStoreTests` → PASS.
- [ ] **Step 5: Commit** `feat(ios): resumable staged rebuild from the library listing`.

### Task 6: iOS model — rebuild through the listing, with 404 fallback

**Files:**
- Modify: `App/ReaderAppModel.swift` (the `requiresFullRebuild` branch of `performOfflineLibraryPreparation`, around the `beginFullRebuild` / `synchronizeIncrementally(fullRebuild:)` calls)
- Test: `PigeonReaderTests/App/ReaderAppModelTests.swift` (extend the private `IntegritySyncHTTPClient` with optional `libraryResponses: [SyncResponse]` served for `/api/v1/library`, default 404, and record them in `requests()`)

**Interfaces:**
- Consumes: Task 3 client methods, Task 5 store methods.
- Produces (private): `func rebuildFromLibraryListing(accountID: String, apiClient: PigeonAPIClient, preparationID: UUID, resumeContinuation: String?, dayBounds: ReaderLocalDayBounds) async throws -> Bool` — returns `false` when the first request answers 404 (caller abandons nothing, calls legacy `beginFullRebuild` + `synchronizeIncrementally(fullRebuild: true)`), `true` when the listing completed; uses `incrementalSyncWithRetry`-style retry for 502/503/1102 with halving `limit`.
- After the listing, the existing tail runs unchanged: `loadNavigation(force:)`, `loadLibrary(force:)`, `finishSynchronization`, `hydrateCommittedOfflineSnapshot`. The catch-up from the snapshot cursor happens on the next preparation (deliberate: avoids a second sync loop inside the rebuild; changes made during a seconds-long listing are rare).
- On cancellation or error mid-listing: keep the marker (do not delete staged rows), state stays `.needsRepair`; next preparation resumes.

- [ ] **Step 1: Failing tests:**
  - `rebuildUsesTheLibraryListingInsteadOfReplayingTheChangeLog`: legacy cache (as in `legacyCacheAutomaticallyRebuildsOnceThenUsesTheWarmCursor`) with two library pages → no `/api/v1/sync` request during the rebuild, cache `.complete`, then a second `prepareOfflineLibrary()` sends one sync request with `cursor == snapshotCursor`.
  - `rebuildFallsBackToTheChangeLogWhenTheServerHasNoListing`: library 404 → legacy behaviour (the existing test's expectations: sync limit 50, cursor nil).
  - `interruptedListingRebuildResumesFromItsContinuation`: page 1 ok, page 2 HTTP 500 → state not complete; next `prepareOfflineLibrary(force: true)` requests `continuation` = page 1's continuation (not a fresh first page).
- [ ] **Step 2: Run** `-only-testing:PigeonReaderTests/ReaderAppModelTests` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `PigeonReaderTests` (all unit tests) → PASS. Existing rebuild tests pass unchanged because their clients answer 404 for `/api/v1/library`; any test client that answers 200 for every path is changed to 404 for `/api/v1/library` (list them in the commit message).
- [ ] **Step 5: Commit** `feat(ios): rebuild the offline library from the unread-first listing`.

### Task 7: iOS model — refresh never waits on a rebuild

**Files:**
- Modify: `App/ReaderAppModel.swift` (`refreshCollection`)
- Test: `PigeonReaderTests/App/ReaderAppModelTests.swift`

**Interfaces:**
- Produces (private): `func startOfflinePreparationInBackground()` — starts `prepareOfflineLibrary(force: true)` in an unstructured task unless `offlinePreparationTask` already exists; does not await.
- `refreshCollection`: when `offlineCacheIntegrity.requiresFullRebuild || offlineRepairInProgress`, call `startOfflinePreparationInBackground()` and go straight to `loadCollectionFromNetwork(collection:force: true, now:)` and `loadNavigation(force: true)`; the `syncBackedCompleteFeed` early return applies only when no rebuild is pending. Otherwise unchanged (a warm incremental sync is awaited as today).

- [ ] **Step 1: Failing test** `pullToRefreshReturnsWhileARebuildIsStillListing`: store in `.needsRepair`; HTTP client whose `/api/v1/library` (and `/api/v1/sync`) responses block on a continuation the test controls (pattern: `ControlledHTTPClient.swift`); `await model.refresh(collection:)` returns while the library request is still blocked; the visible collection's stream request was made; then release the gate and `await` preparation → `.complete`.
- [ ] **Step 2: Run** → FAIL (refresh hangs; use a `withTimeout`-style helper already in the tests or a 2 s `Task` race).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `PigeonReaderTests` → PASS.
- [ ] **Step 5: Commit** `fix(ios): pull-to-refresh no longer waits for a library rebuild`.

### Task 8: iOS — body downloads (foreground, background refresh, on open)

**Files:**
- Create: `App/ReaderAppModel+ArticleFetching.swift` (run `xcodegen generate` in `ios/PigeonReader`)
- Modify: `App/ReaderAppModel.swift` (state, start points, cancellation on account change where `offlinePreparationTask` is cancelled, `performBackgroundRefresh`), `Features/Reader/ArticleReaderView.swift`
- Test: `PigeonReaderTests/App/ReaderAppModelTests.swift`

**Interfaces:**
- Consumes: Task 3 `libraryArticles(ids:)`, Task 4 store methods.
- Produces:
  - `@Observable` state on the model: `private(set) var articleIDsLoadingBody: Set<String>`.
  - `func downloadMissingArticles() async` — structured and cancellable: loop `articleIDsNeedingFetch(limit: 20)` → `libraryArticles(ids:)` → `applyFetchedArticles` → `replaceCachedMatches(with:)` for each returned article → `markArticlesUnavailable(missing)`; ids neither returned nor missing are retried in the next batch; stop when empty, on cancellation, on a non-transient error, or when `BackgroundRefreshPolicy.shouldRefresh(...)` is false.
  - `func startArticleDownloadsIfNeeded()` — one stored task wrapping `downloadMissingArticles()`; called at the end of `prepareOfflineLibrary` when `isApplicationActive`; cancelled with `offlinePreparationTask` on account change/sign-out.
  - `func ensureArticleBody(for article: Recommendation) async` — no-op when `article.hasReadableHTML`; otherwise fetch that single id first (inserting into `articleIDsLoadingBody` while in flight), apply, update caches.
  - `performBackgroundRefresh`: after `prepareOfflineLibrary()` (inside the same `withTaskCancellationHandler`), `await downloadMissingArticles()`.
  - `ArticleReaderView`: `.task(id: article.id) { await model.ensureArticleBody(for: article) }`; in `.feedContent`, when `article.html` is empty and `model.articleIDsLoadingBody.contains(article.id)`, show a `ProgressView` in place of `ArticleBodyView` (style per `DESIGN.md`).
  - `cachedCollectionHasMissingBodies` stays as is: its network page load is exactly the on-demand body fetch for the visible page (spec §5 resolved this way; note it in the commit).

- [ ] **Step 1: Failing tests:**
  - `missingArticleBodiesDownloadNewestUnreadFirst`: after a listing rebuild with three body-less unread articles, `downloadMissingArticles()` posts ids in `received_at` DESC order and the articles then have html.
  - `missingArticlesAreNotRequestedTwice`: response reports one id `missing` → a second `downloadMissingArticles()` does not request it.
  - `articleDownloadsStopWhenCancelled`: cancel the task after the first batch → no second request.
  - `openingAnArticleWithoutABodyFetchesItFirst`: `ensureArticleBody` requests exactly that id and the cached article gains html.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `PigeonReaderTests` → PASS; build the app target.
- [ ] **Step 5: Commit** `feat(ios): download unread article bodies in the background and on open`. Push; open **PR 2 (iOS)** after PR 1 merged (branch from `origin/main`), with the smoke UI tests from CI.

### Task 9: Ship together

- [ ] Both PRs reviewed (`/code-review` or self-review subagent), `Workstream reviewed head` posted, merged with merge commits, `main` green.
- [ ] Deploy per project CLAUDE.md: compare `npx wrangler deployments list` with `main`, check live `schema_version` (no bump expected), `npm run deploy`, `curl https://pigeon.hanscho.com/health`, then `curl` `/api/v1/library?limit=5` with the API token → 200 and `wrangler tail --format json` shows `cpuTime` well under budget for a 200-row page and a 50-id article fetch.
- [ ] CHANGELOG `## [<version>] - <date>` + `VERSION` PR, merged; release from clean `main` with `node scripts/release-new-build-to-testflight.mjs --monitor-state /tmp/pigeon-release-request.json --monitor-receipt /tmp/pigeon-release-receipt.json`; report the build number.
- [ ] On Hans's phone after installing: Offline Library leaves "Repairing…" within seconds; `wrangler tail` shows `library` pages then `library/articles` batches, not `sync?limit=50`.
