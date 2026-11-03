# Read It Later step 2: schema v16 and reading length — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every article in Pigeon carries a reading length; web and iOS label the ones over 10 minutes ("12 min read", "18 min video") on list rows and the article header, behind a "Show reading time" setting that defaults to on.

**Architecture:** Schema v16 adds nullable metadata columns to `items` (plus `item_transcripts` for step 5). The Worker counts words at ingest with a cheap linear scanner. An hourly cron backfills existing items within a byte budget, and fills YouTube durations through one `videos.list` call per run. Sync and GReader payloads gain optional `wordCount`, `mediaKind` and `durationSeconds`. Clients format the label locally. When reader mode extracts a much longer article than the stored count (snippet-only RSS), the client reports Defuddle's count through a `set_word_count` mutation.

**Tech Stack:** Cloudflare Worker + D1 (TypeScript, `tsx --test`); the web client emitted from `src/browser-app*.ts`; iOS SwiftUI + raw SQLite store (Swift Testing, xcodebuild).

**Spec:** `docs/superpowers/specs/2026-11-03-read-it-later-design.md` (sections "Schema v16 (additive)" and "Reading length for all articles").

## Global Constraints

- Schema bump is one-way: v16 ships in a normal deploy, never a hotfix. `04-storage/SCHEMA.sql` mirrors `src/migrations.ts`.
- Additive only; no rewrite of existing rows in one request. Backfill runs in bounded batches from the cron.
- Reading speed **238 words per minute**, rounded **up** to whole minutes, minimum 1.
- Video shows its duration instead of a word count.
- Writers to `items` avoid no-op updates (`WHERE col IS NOT ?`). Never delete `sync_changes` rows.
- Worker Free plan: 10 ms CPU per invocation (cron included); D1 query budget per cron run is `RefreshQueryBudget(47)`.
- API stays backward compatible with the TestFlight build: new fields are optional and omitted when null.
- Setting "Show reading time", default **on**, only hides the label.
- Two PRs. PR A (Worker + web, `src/`, `test/`, `04-storage/`, `docs/`) never touches the Mac. PR B (iOS) is cut from `main` after PR A merges.

## Decisions taken here (builder's calls the spec left open)

- **The saved feed is not created in v16.** `feeds.source_type` has no CHECK constraint, so step 3 creates `pigeon:saved` lazily on the first save. That keeps an empty "Read It Later" feed off older clients until step 3 ships.
- **How clients learn backfilled values:** v16 recreates `trg_sync_article_update` so that it also fires on the eight new columns. Every metadata writer also bumps `content_version`, so GReader clients refetch. Each item pays for this once.
- **Backfill scope:** items with `word_count IS NULL AND content_pruned_at IS NULL`, newest first. Pruned items keep no length (the label is hidden).
- **Counting:** HTML when present, otherwise text. The scan covers at most `WORD_COUNT_SOURCE_LIMIT = 300_000` characters and skips tags, comments, `<head>`, `<style>`, `<script>` and `<template>`.
- **Media kind:** `'video'` when `original_url` yields a YouTube video ID (RSS ingest and backfill), otherwise `'text'`. Email is always `'text'`.
- **Duration unknown:** a video absent from the API response, or `P0D` (a live stream), stores `0`. A `0` hides the label and stops retries.
- **Report threshold:** a client reports when the extracted count is at least 50 words and either the stored count is null or the extracted count is at least 1.5 times the stored count. Videos never report.
- **Label format:**
  - Text: `"<n> min read"`.
  - Video: `"<m> min video"` with `m = max(1, round(s/60))`. At 60 minutes or more, `"<h> hr <r> min video"`, or `"<h> hr video"` when `r` is 0.
  - A missing or zero value shows no label.
  - **Only lengths over 10 minutes get a label** (Hans, 2026-11-03): text needs 11+ minutes (`wordCount > 2380`), video needs `m >= 11`. Shorter items show nothing. The stored values are unaffected, so step 3's length filters and sorts still see every item.

## Review Focus

1. **A 900 KB newsletter at ingest or backfill** must not blow the CPU budget. The scanner caps at 300 000 characters, and the backfill caps the bytes it pulls per run (Task 2 and Task 5 tests).
2. **A re-delivered email or an RSS refresh with unchanged content** must not rewrite `word_count` or add a sync change (Task 2 test).
3. **`set_word_count` with the same value twice** must leave `content_version` and `sync_changes` unchanged (Task 4 test).
4. **A YouTube API outage, a missing key, or a deleted video** must not cause a retry storm. A missing key or a non-200 response writes nothing; an absent ID stores 0 (Task 5 test).
5. **Image-only items (0 words)** store 0, are never selected again, and show no label (Task 5 and Task 6 tests).

---

## PR A: Worker and web (branch `claude/reading-length`)

### Task 1: Schema v16 migration

**Files:**
- Modify: `src/migrations.ts` (add `V15` constant, rebind the v15 CAS to `String(V15)`, append the v16 block, `REQUIRED_SCHEMA_VERSION = '16'`)
- Modify: `04-storage/SCHEMA.sql` (header v16, `_meta` '16', columns, table, indexes, trigger column list, `content_version` comment)
- Modify: `test/migrations.test.ts`, `test/schema-test-helpers.ts` (`schemaVersion: '16'`, `itemColumns` gains the 8 columns)

**Interfaces:**
- Produces:
  - `items` columns `word_count INTEGER`, `media_kind TEXT`, `duration_seconds INTEGER`, `author TEXT`, `published_at TEXT`, `image_url TEXT`, `site_name TEXT`, `extraction_state TEXT`.
  - Table `item_transcripts(item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, language TEXT, html TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`.
  - `idx_items_word_count_pending ON items(received_at DESC) WHERE word_count IS NULL AND content_pruned_at IS NULL`.
  - `idx_items_video_duration_pending ON items(received_at DESC) WHERE media_kind = 'video' AND duration_seconds IS NULL`.
  - `trg_sync_article_update` fires `AFTER UPDATE OF feed_key, subject, from_name, html_content, text_content, original_url, received_at, content_pruned_at, word_count, media_kind, duration_seconds, author, published_at, image_url, site_name, extraction_state`.

- [ ] **Step 1: Write the failing tests** in `test/migrations.test.ts`:
  - Add `createSqliteV15Fixture`: load SCHEMA.sql, drop the 8 columns, drop `item_transcripts` and both indexes, recreate the old v15 trigger, and set the version to '15'.
  - `migrates v15 to v16 additively`: the version becomes '16'; the 8 columns exist and are null on a pre-existing row; `item_transcripts` exists; both partial indexes exist; the final batch's CAS values are `['16','15']`.
  - `v16 article trigger records word_count updates`: `UPDATE items SET word_count = 120 WHERE id = ?` adds exactly one `sync_changes` row `('article', id)`; `UPDATE items SET is_read = 1` adds no article row.
  - Update the fresh-schema test (`:1300`) to expect '16' and no migration work. Update the hard-coded batch shapes in earlier tests (`:906-913`, `:1067-1089`, `:1210`, `:1273`) so v12/v13/v14 fixtures also run the v16 block.
- [ ] **Step 2: Run** `npx tsx --test test/migrations.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the v16 block in `runDatabaseMigrations`:
  - `addColumnIfMissing` for each column.
  - One `db.batch`: `CREATE TABLE IF NOT EXISTS item_transcripts …`, both `CREATE INDEX IF NOT EXISTS`, `DROP TRIGGER IF EXISTS trg_sync_article_update`, the new `CREATE TRIGGER`, then `UPDATE _meta SET value='16' WHERE key='schema_version' AND value='15'`.
  - Mirror everything in SCHEMA.sql.
- [ ] **Step 4: Run** `npm test`. Expected: all PASS. Many suites load SCHEMA.sql, so they confirm the mirror.
- [ ] **Step 5: Commit** `feat(schema): v16 adds reading-length metadata and item transcripts`.

### Task 2: Word counts and media kind at ingest

**Files:**
- Create: `src/word-count.ts`, `test/word-count.test.ts`
- Modify: `src/youtube.ts` (move `extractYouTubeVideoId` here from `src/browser-app-client.ts`; the client imports it and keeps emitting it via `.toString()`)
- Modify: `src/email-handler.ts:211` (insert), `src/rss-fetcher.ts:165-251` (`buildRssItemStatements`: 11 placeholders at every site, including `bufferedSql.replace`; the `updateExisting` upsert sets `word_count`/`media_kind` from `excluded`)
- Test: `test/email-handler*.test.ts`, `test/rss-fetcher*.test.ts` (the existing files that cover these inserts)

**Interfaces:**
- Produces:
  - `export const WORD_COUNT_SOURCE_LIMIT = 300_000`
  - `export function countWordsInHtml(html: string): number`
  - `export function countWordsInText(text: string): number`
  - `export function countItemWords(html: string | null, text: string | null): number`: uses HTML when it is non-empty, otherwise text, otherwise 0.
  - `export type MediaKind = 'text' | 'video'`
  - `export function mediaKindForUrl(url: string | null | undefined): MediaKind` in `src/youtube.ts`.

- [ ] **Step 1: Write the failing tests** in `test/word-count.test.ts`:
  - `countWordsInHtml('<p>Hello <b>big</b> world</p>') === 3`.
  - Tags split words: `'<p>one</p><p>two</p>'` → 2.
  - `<style>`, `<script>`, `<head>` and `<!-- … -->` content is not counted.
  - `'a&nbsp;b'` → 2. `'caf&eacute;'` → 1.
  - `countWordsInText('  one\ntwo\tthree ') === 3`. Empty → 0.
  - **Cap:** `countWordsInHtml('<p>' + 'word '.repeat(200_000) + '</p>')` equals the count over the first 300 000 characters (60 000 words), and it finishes in under 50 ms on the dev machine (`performance.now()`).
  - `countItemWords('', 'two words') === 2`; `countItemWords(null, null) === 0`.
  - `mediaKindForUrl('https://youtu.be/dQw4w9WgXcQ') === 'video'`, `mediaKindForUrl('https://example.com/a') === 'text'`, `mediaKindForUrl(null) === 'text'`.
- [ ] **Step 2: Write the failing ingest tests** in the existing email and RSS test files:
  - An inserted email row has `word_count` equal to `countItemWords(html, text)` and `media_kind = 'text'`.
  - An RSS item whose link is `https://www.youtube.com/watch?v=dQw4w9WgXcQ` stores `media_kind = 'video'`.
  - **No-op:** re-running the RSS upsert with unchanged content leaves `sync_changes` row count unchanged. Changing the content updates `word_count`.
- [ ] **Step 3: Run** `npx tsx --test test/word-count.test.ts` plus those files. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - Scanner: a single `charCodeAt` loop over at most `WORD_COUNT_SOURCE_LIMIT` characters. It counts transitions from whitespace into non-whitespace, outside tags. Raw-text elements (`style`, `script`, `head`, `template`) are skipped to their closing tag. Entities `&nbsp;`, `&#160;` and `&#xa0;` count as whitespace; other entities count as word characters. No regex replace over the whole body.
  - Move `extractYouTubeVideoId` unchanged and update the client import.
- [ ] **Step 5: Run** `npm test`. Expected: PASS, including the existing browser YouTube tests.
- [ ] **Step 6: Commit** `feat(worker): count words and tag video items at ingest`.

### Task 3: Reading-length fields in sync and GReader payloads

**Files:**
- Modify: `src/sync-api.ts` (`ArticleSyncRow` :39, SELECT :181-186, payload :216-231)
- Modify: `src/greader.ts` (row type :717, SELECT :774, item object :826-851)
- Modify: `test/api-contract.test.ts` (seed one text item with `word_count = 2380` and one video item with `media_kind='video', duration_seconds=1100`), then regenerate `test/fixtures/api-contract/*.json` with `UPDATE_CONTRACT_FIXTURES=1`
- Test: `test/sync-api.test.ts`

**Interfaces:**
- Produces:
  - JSON fields on sync article payloads and GReader items: `wordCount?: number`, `mediaKind?: 'text' | 'video'`, `durationSeconds?: number`, each omitted when the column is null.
  - Web type: `BrowserLoadedItem` gains these three optional fields (Task 6).
  - iOS: Task 7 decodes them.

- [ ] **Step 1: Write the failing tests.**
  - Sync: an article with `word_count = 500` has `wordCount: 500`; an article with null columns has none of the three keys.
  - GReader `stream/items/contents`: same rule.
  - Contract: the fixtures contain `wordCount`, `mediaKind` and `durationSeconds` on the seeded items.
- [ ] **Step 2: Run** `npx tsx --test test/sync-api.test.ts test/api-contract.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the fields, then regenerate the fixtures.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Check `git diff test/fixtures` shows only the added keys.
- [ ] **Step 5: Commit** `feat(api): return word count, media kind and duration on articles`.

### Task 4: `set_word_count` mutation

**Files:**
- Modify: `src/mutation-api.ts` (`MutationKind` :12, `ClientMutation` gains `wordCount?: number`, `validateMutationBatch` :122, `mutationStatements` :185, `isMutationKind` :365, `worstCaseQueries` :83)
- *(Moved to Task 9.)* The shared `mutations.request.json` fixture gains `set_word_count` in the iOS PR. iOS compares its encoded request against that fixture exactly, so adding it here would break the iOS contract test on `main`. Target item 2 there, so item 1's status event (asserted at `APIContractTests.swift:90`) is not compacted away.
- Test: `test/sync-api.test.ts` (mutation section :238-435)

**Interfaces:**
- Produces: the mutation `{ id, kind: 'set_word_count', itemIds: [oneId], wordCount: integer 1…2_000_000 }`. It applies `UPDATE items SET word_count = ?, content_version = content_version + 1 WHERE rowid = ? AND word_count IS NOT ?`. No `item_statuses` or engagement writes.

- [ ] **Step 1: Write the failing tests.**
  - Apply: `word_count` becomes the value, `content_version` goes up by 1, and one article `sync_changes` row is added.
  - **Same value again** (new mutation id): status `applied`, but `content_version` and the `sync_changes` count are unchanged.
  - Validation 400s: `wordCount` missing, `0`, `2.5`, `2_000_001`, or `itemIds` with 2 entries.
  - A replayed mutation id returns `already_applied`.
- [ ] **Step 2: Run** the mutation tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): let clients report extracted word counts`.

### Task 5: Cron backfill for word counts and YouTube durations

**Files:**
- Create: `src/item-metadata-backfill.ts`, `test/item-metadata-backfill.test.ts`
- Modify: `src/cron-handler.ts:100` (call the backfill last, in its own try/catch. Restructure so the early `return` in the refresh block cannot skip it.)

**Interfaces:**
- Consumes: `countItemWords`, `mediaKindForUrl`, `extractYouTubeVideoId` (Task 2); `RefreshQueryBudget` (`src/rss-fetcher.ts:39`); `fetchBoundedFeedResource` (`src/feed-network.ts:41`).
- Produces:
  - `export const BACKFILL_CANDIDATE_LIMIT = 100`
  - `export const BACKFILL_BYTE_BUDGET = 500_000` (halved from the first draft: it shares the 10 ms cron CPU with five feed refreshes)
  - `export const YOUTUBE_DURATION_BATCH = 50`
  - `export async function runWordCountBackfill(db: D1Database, budget: RefreshQueryBudget): Promise<number>`: returns the number of rows updated. Three queries:
    1. `SELECT id, original_url, length(html_content) AS html_len, length(text_content) AS text_len` over the pending index, `ORDER BY received_at DESC LIMIT 100`.
    2. Choose the longest prefix whose `min(len, WORD_COUNT_SOURCE_LIMIT)` sum stays at or under `BACKFILL_BYTE_BUDGET`, always at least one row. Fetch `substr(html_content, 1, 300000)` and `substr(text_content, 1, 300000)` for those ids.
    3. One `UPDATE … FROM json_each(?)` statement that sets `word_count`, `media_kind` and `content_version + 1`, guarded by `word_count IS NULL`.
  - `export function parseYouTubeDuration(iso: string): number | null`
  - `export async function runYouTubeDurationBackfill(db: D1Database, budget: RefreshQueryBudget, apiKey: string | undefined, fetchImpl?: typeof fetch): Promise<number>`:
    - With no key it returns 0 and makes no query.
    - Otherwise it runs one SELECT on the video index (LIMIT 50) and one `videos?part=contentDetails&id=…` fetch with the `x-goog-api-key` header.
    - On a non-200 response or a parse failure it writes nothing.
    - Otherwise it runs one UPDATE that sets `duration_seconds` (0 for absent ids) and `content_version + 1`, guarded by `duration_seconds IS NULL`.

- [ ] **Step 1: Write the failing tests:**
  - `parseYouTubeDuration`: `'PT1H2M3S'` → 3723, `'PT18M20S'` → 1100, `'P0D'` → 0, `'P1DT2H'` → 93600, `'garbage'` → null.
  - Backfill fills `word_count`/`media_kind` newest first and skips pruned rows.
  - **Byte budget:** with three 300 KB items it updates exactly one per run, and three runs finish them all.
  - **Zero words:** an image-only item stores 0 and is not selected on the next run.
  - It reserves 3 budget units and does nothing when `budget.reserve` fails.
  - Duration: the stubbed fetch returns two of three ids, so the third stores 0.
  - **No retry storm:** a 500 response writes nothing; no key means no fetch.
  - `handleCronTrigger` runs both backfills even when no RSS feed is due (extend `test/sync-api.test.ts:775-820`).
- [ ] **Step 2: Run** `npx tsx --test test/item-metadata-backfill.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cron): backfill reading length and YouTube durations in bounded batches`.

### Task 6: Web label, setting, and word-count report

**Files:**
- Modify: `src/browser-app-client.ts`:
  - `BrowserLoadedItem` :48 gains the 3 fields.
  - `BrowserArticleListEntry` :70 gains `readingLength: string | null`.
  - `buildArticleListEntries` :579 takes an options argument and fills `readingLength`.
  - Add `formatReadingLength` and `shouldReportWordCount`, both emitted in `renderBrowserAppClientScript`.
- Modify: `src/browser-app.ts`:
  - `createArticleMetadata` :1134 must keep the 3 fields.
  - List meta `:2533-2541` appends `span.article-length`; it is hidden when null or when the setting is off.
  - The `#reader-source-note` text (`:2869-2875`) appends `· <label>`.
  - Settings HTML Reading section `:312-354` gets `<label><input type="checkbox" id="show-reading-time"> Show reading time</label>`.
  - Key `pigeon.browser.show-reading-time` (`'0'`/`'1'`, default on), with get/set helpers next to `getStoredArticleListMode` (:593-610). It is restored at boot (:4725), and its change handler re-renders `renderArticles(); renderReader()`.
  - After extraction in `prepareReadingFrame` (:2771, guarded by `current()`), a fire-and-forget `authenticatedFetch('/api/v1/mutations', …)` posts a `set_word_count` mutation when `shouldReportWordCount` says so. It sends once per item per session and ignores failures.
- Test: `test/browser-app-client-pure.test.ts`, `test/browser-app-client-shell.test.ts`, `test/browser-app-client-reader.test.ts`, `test/browser-app-client-actions.test.ts`

**Interfaces:**
- Consumes: the payload fields from Task 3 and the mutation from Task 4.
- Produces:
  - `export function formatReadingLength(item: { wordCount?: number | null; mediaKind?: string | null; durationSeconds?: number | null }): string | null`. It must be self-contained, because it is emitted via `.toString()`.
  - `export function shouldReportWordCount(stored: number | null | undefined, extracted: number | null | undefined, mediaKind: string | null | undefined): boolean`.

- [ ] **Step 1: Write the failing pure tests:**
  - `formatReadingLength({wordCount: 1})` → null; `{wordCount: 2380}` (exactly 10 min) → null.
  - `{wordCount: 2381}` → `'11 min read'`; `{wordCount: 2856}` → `'12 min read'`.
  - `{wordCount: 0}` → null; `{}` → null.
  - `{mediaKind: 'video', durationSeconds: 1100}` → `'18 min video'`.
  - `{mediaKind: 'video', durationSeconds: 600}` → null; `{mediaKind: 'video', durationSeconds: 660}` → `'11 min video'`; `{mediaKind: 'video', durationSeconds: 20}` → null.
  - `{mediaKind: 'video', durationSeconds: 3900}` → `'1 hr 5 min video'`; `{mediaKind: 'video', durationSeconds: 7200}` → `'2 hr video'`.
  - `{mediaKind: 'video', durationSeconds: 0, wordCount: 900}` → null.
  - `shouldReportWordCount(null, 600, 'text')` → true; `(100, 149, 'text')` → false; `(100, 150, 'text')` → true; `(null, 49, 'text')` → false; `(null, 900, 'video')` → false.
- [ ] **Step 2: Write the failing harness tests:**
  - A list row for an item with `wordCount: 2856` shows `12 min read` in `.article-length`; a row with `wordCount: 900` has no `.article-length`.
  - With `localStorageState['pigeon.browser.show-reading-time'] = '0'`, no `.article-length` appears and the reader source note has no label.
  - Toggling `#show-reading-time` stores `'0'`/`'1'` and re-renders.
  - The reader header shows the label.
  - A reader-mode extraction with an `extractReader` stub returning `wordCount: 1200` for an item with `wordCount: 40` posts one `set_word_count` with `wordCount: 1200`. Re-opening the item posts nothing more. Extraction with `wordCount: 45` posts nothing.
- [ ] **Step 3: Run** those test files. Expected: FAIL.
- [ ] **Step 4: Implement.** In the meta line the label sits after the time, in the existing `.article-meta` muted style (no new badge styling).
- [ ] **Step 5: Run** `npm run check`. Expected: PASS (tests, typecheck, audit).
- [ ] **Step 6: Verify in a browser.** Run `npx wrangler dev` on a local D1 seeded with the fixtures and open `/app`. Confirm the labels on rows and the header, the toggle surviving a reload, and the mutation in the network log.
- [ ] **Step 7: Commit** `feat(web): show reading time with a setting and report extracted counts`.

**PR A ship:** push, open the PR, wait for CI, run `/code-review`, fix what it finds, post `Workstream reviewed head`, merge with a merge commit, confirm `main` is green, then remove nothing yet (PR B uses a new worktree).

---

## PR B: iOS (branch `claude/reading-length-ios`, from `main` after PR A)

### Task 7: Decode and persist the new fields

**Files:**
- Modify:
  - `Core/Recommendation.swift`: `wordCount: Int?`, `mediaKind: String?`, `durationSeconds: Int?`, defaulting to nil. `replacingBody` copies them.
  - `Core/OfflineLibraryModels.swift:31-58`: `IncrementalSyncPayload` gets the same three optionals.
  - `Core/ReaderAPIModels.swift:84-127`: `ReaderStreamItem` CodingKeys plus `decodeIfPresent`.
  - `Core/PigeonAPIClient.swift:611-636`: the mapping.
  - `Core/OfflineLibraryStore.swift`: every full `Recommendation(...)` constructor (:1041, :1315, :1552, :1858). The `.article` apply branch (:1268-1331) uses `payload.x ?? existing?.article.x`.
  - `App/ReaderAppModel.swift`: `mergedArticle` :3889, `articleWithStatuses` :3927, `sharedFields` :3958.
  - `Development/PreviewData.swift`.
- Test: `PigeonReaderTests/Core/APIContractTests.swift` (assert the decoded values from the regenerated fixtures), `Core/OfflineLibraryStoreTests.swift` (template `syncedPaywallFlagFollowsTheStoredBody` :208), `Core/PigeonAPIClientTests.swift`

**Interfaces:**
- Produces: `Recommendation.wordCount`, `.mediaKind`, `.durationSeconds`.

- [ ] **Step 1: Write the failing tests.**
  - The contract fixture decodes `wordCount == 2380` on the text item and `mediaKind == "video"`, `durationSeconds == 1100` on the video item.
  - `syncedReadingLengthSurvivesStoreRoundTrip`: apply a sync page with `wordCount: 500`, reload, and the value is 500. A later change without the field keeps 500.
  - GReader decode maps all three fields.
- [ ] **Step 2: Run** `xcodebuild test … -only-testing:PigeonReaderTests` (command in `CLAUDE.md`, simulator `Pigeon Claude`). Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ios): carry word count, media kind and duration on articles`.

### Task 8: Reading-length label and setting

**Files:**
- Create: `Core/ReadingLength.swift`, `PigeonReaderTests/Core/ReadingLengthTests.swift`
- Modify:
  - `Core/ReaderTypographySettings.swift`: `showsReadingTime: Bool`, key `"pigeon.reader.shows-reading-time"`, read with `defaults.object(forKey:) as? Bool ?? true`; `reset()` restores true.
  - `Features/Settings/SettingsView.swift` `Section("Reading")` (:123-197): `Toggle("Show reading time", isOn: $typography.showsReadingTime)`.
  - `App/PigeonReaderApp.swift:20-35`: add the key to the UI-test reset list.
  - `Features/Reader/ArticleRowView.swift`: meta HStack :108-128 and accessibility value :142-145.
  - `Features/Reader/FrontPageView.swift`: `FrontPageStoryView` meta :207-215 and accessibility :239-244.
  - `Features/Reader/ArticleReaderHeaderView.swift`: source/date line :54-62.
  - Pass the setting down from `model.readerTypography` where these views are built.
- Test: `ReadingLengthTests.swift`, `Core/ReaderTypographySettingsTests.swift`, `Features/ArticleRowViewTests.swift`

**Interfaces:**
- Produces: `enum ReadingLength { static func label(wordCount: Int?, mediaKind: String?, durationSeconds: Int?) -> String? }`, with the same rules and vectors as the web `formatReadingLength`.

- [ ] **Step 1: Write the failing tests:**
  - `ReadingLengthTests` uses the exact vectors from Task 6 Step 1.
  - Settings: the default is true, false persists across a new `ReaderTypographySettings(defaults:)`, and `reset()` restores true.
  - The row accessibility value includes `"12 min read"` when the setting is on and omits it when off.
- [ ] **Step 2: Run** `-only-testing:PigeonReaderTests`. Expected: FAIL.
- [ ] **Step 3: Implement.** The label uses the row's existing secondary metadata style: plain text with a `·` separator, no badge, no icon. That keeps it editorial rather than Mail-like.
- [ ] **Step 4: Run** the tests, then `xcodegen generate` (new files) and rerun. Expected: PASS.
- [ ] **Step 5: Verify in the simulator.** On `Pigeon Claude` with the dev server, check the label on the timeline, front page and reader header, the toggle hiding it everywhere, and the setting surviving a relaunch.
- [ ] **Step 6: Commit** `feat(ios): show reading time with a setting`.

### Task 9: Report extracted word counts

**Files:**
- Modify:
  - `Core/OfflineLibraryModels.swift:60-111`: `OfflineMutationKind.setWordCount = "set_word_count"` and `OfflineMutation.wordCount: Int?`.
  - `Core/OfflineMutationReplayer.swift:171-211`: a `permanentValidationError` case.
  - `App/ReaderAppModel.swift` `loadReaderView(for:)` (:2241-2280): after both success points, enqueue it when `ReadingLength.shouldReport(stored:extracted:mediaKind:)` says so.
- Test: `App/ReaderAppModelTests.swift` (inject `readerViewExtractor:`, following :439/:508), `Core/OfflineMutationReplayerTests` if present, `APIContractTests.mutationRequestAndResponsesMatchTheContract` (:55, the fixture gains `set_word_count` in Task 4)

**Interfaces:**
- Consumes: the `set_word_count` contract (Task 4).
- Produces: `ReadingLength.shouldReport(stored: Int?, extracted: Int?, mediaKind: String?) -> Bool`, with the same rule as the web `shouldReportWordCount`.

- [ ] **Step 1: Write the failing tests:**
  - `shouldReport` vectors from Task 6 Step 1.
  - An extraction with `wordCount: 1200` on an article with `wordCount: 40` enqueues one `set_word_count` with `itemIds == [readerId]` and `wordCount == 1200`.
  - A cached second open enqueues nothing.
  - A video article enqueues nothing.
  - The contract mutation fixture round-trips through `OfflineMutation`.
- [ ] **Step 2: Run** `-only-testing:PigeonReaderTests`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the unit tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ios): report reader-view word counts to the server`.

**PR B ship:** the same merge flow as PR A. The iOS job runs on the shared Mac, so never cancel it.

**After both merge:** labels appear only after a **deploy** (schema v16 is one-way) and a **release**. Report that and wait for Hans to say either word.
