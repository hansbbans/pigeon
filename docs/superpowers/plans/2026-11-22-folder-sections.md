# Folder sections, Last 7 Days and the Cards look: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parts 1 and 2 of the spec: the web app gets Last 7 Days and the new folder sections in its Reeder look; iOS gets the Cards/Reeder setting, folder cards, All Feeds tiles and Last 7 Days.

**Architecture:** One pure "folder sections" function per platform (same rules, same limits) turns a folder's loaded stories into Today / Last 7 Days / per-feed / Older sections; each look only renders it. Last 7 Days is a client-side time window over existing endpoints on both platforms; the Worker does not change.

**Tech Stack:** Worker web app: TypeScript template-string client (`src/browser-app.ts`, pure helpers in `src/browser-app-client.ts`), tests with `node:test` via `tsx`. iOS: SwiftUI, Swift Testing, xcodegen.

**Spec:** `docs/superpowers/specs/2026-11-22-folder-cards-design.md`

## Global Constraints

- Section rules (both platforms, both looks), all in local time:
  - **Today**: stories with `receivedAt` (web: `published`) in `[local midnight today, next local midnight)`, newest first. Shows 5, then "N more" expands in place to every loaded one. Omitted when empty.
  - **Last 7 Days**: `[local midnight 6 days before today, local midnight today)` — yesterday and the 5 days before it, excluding today. Newest first, 5 then "N more". Omitted when empty. Title "Last 7 Days".
  - **Feed sections**: one per feed with loaded stories, ordered by that feed's newest story (newest first; tie → feed title, then feed id). Each shows its newest 3, then "N more". Stories in Today / Last 7 Days also appear here.
  - **Older**: feeds whose newest loaded story is before the Last 7 Days start go after an "Older" header, same rules.
  - Read filter: Unread shows only unread stories in every section; All keeps read stories in place, styled as read.
- The **Last 7 Days view** (a smart view, not a folder section) covers `[local midnight 6 days before today, next local midnight)` — today included — across all feeds, newest first. Reading-log list name `last-7-days`.
- Folders have no sort menu any more on web, nor in Cards on iOS (sections are the order). Folder stories load newest first.
- A story shown twice counts as one impression per visit, at the position of its first appearance.
- iOS: `ReaderLook` `cards` | `reeder` replaces `ReaderHomeLayout`; stored per device under `pigeon.reader.look.v1`; migrate from `pigeon.reader.home-layout.v1`: `front-page` → cards, `classic` → reeder, absent → cards.
- Copy: "Today", "Last 7 Days", "Older", "N more" (e.g. "4 more"), "Cards", "Reeder". Sentence/Title case as in `DESIGN.md`.
- iOS rules from `CLAUDE.md`: `xcodegen generate` after adding files; tests on simulator `Pigeon Claude` only; `-parallel-testing-enabled NO`; `DESIGN.md` contrast, Dynamic Type through `ReaderTypography`, Reduce Motion through `ReaderMotion`. Web rules: existing `--*` tokens, check light, dark and ≤760px; `npm run visual:check` after UI changes.

## Review Focus

1. **Day boundaries**: a story at exactly local midnight belongs to Today; one at 23:59:59 yesterday to Last 7 Days; one exactly 6 days before today's midnight to Last 7 Days, one second earlier to Older. Tested in W1 and I1.
2. **DST week**: the 7-day window across a DST change must use calendar days, not `7 × 86400`. Tested in W1 and I1 with a DST-crossing date in a fixed time zone (America/New_York, 2026-11-01).
3. **Duplicated rows**: keyboard j/k (web), selection highlight, context menu and impression positions with a story in both Today and its feed section. Tested in W3 and I3.
4. **Pagination landing**: a new page adds stories to existing sections and new feed sections without moving the row under the pointer/finger. Covered by W3's runtime test (append order) and I3's manual check.
5. **Unfiled / unknown feed**: a story whose feed is not in the directory falls back to its own key and `source` title (`ArticleFeedDirectory.feed(for:)` on iOS; equivalent on web). Tested in W1 and I1.

---

## Part 1 — Web (branch `claude/folder-cards`, worktree `../pigeon-folder-cards`)

### Task W1: Pure day-window and folder-section helpers

**Files:** Modify `src/browser-app-client.ts`; Test `test/browser-app-client-pure.test.ts`

**Interfaces — Produces:**
- `getLocalDayRangeBounds(now: number, days: number): { start: Date; end: Date; startSeconds: number; endSeconds: number }` — start = local midnight `days - 1` days before `now`'s day, end = next local midnight. `getLocalDayBounds(now)` becomes `getLocalDayRangeBounds(now, 1)`.
- `buildFolderSections(items: FolderSectionItem[], now: number, options?: { todayLimit?: number; recentLimit?: number; feedLimit?: number; expanded?: ReadonlySet<string> }): FolderSection[]` where `FolderSectionItem = { id: string; published: number /* seconds */; streamId: string; feedTitle: string }` and `FolderSection = { key: string; kind: 'today' | 'last-7-days' | 'feed' | 'older-header'; title: string; streamId?: string; itemIds: string[]; hiddenCount: number }`. Defaults 5 / 5 / 3. Section keys: `today`, `last-7-days`, `feed:<streamId>`, `older`. `expanded` holds section keys shown in full.

- [ ] Step 1: Tests: `getLocalDayRangeBounds covers six days back to next midnight across DST` (TZ America/New_York, now = 2026-11-03T12:00 local → start 2026-10-28T00:00 local, end 2026-11-04T00:00 local); `buildFolderSections orders Today, Last 7 Days, feeds by newest, then Older` with the boundary instants from Review Focus 1, a story in both Today and its feed, hiddenCount values for limits, an unknown feed using its own title, and `expanded` lifting a limit.
- [ ] Step 2: Run `npx tsx --test test/browser-app-client-pure.test.ts` — new tests fail.
- [ ] Step 3: Implement both functions.
- [ ] Step 4: Re-run — pass. Commit `feat(web): folder section and day-range helpers`.

### Task W2: Last 7 Days view

**Files:** Modify `src/browser-app-client.ts` (`buildFeedViews` ~652, view kind union :44, `readingLogView` :1125), `src/browser-app.ts` (every `kind === 'today'` site listed in the spec's research: `:1094`, `:2121` `isTodayView`, `:2143-2234`, `:2318`, `:2537`, `:2754`, `:2881`, `:4122-4126`, `:4195`, `:4460`, `:4959`, `:5064`, `:5204-5239`); Test `test/browser-app-client-pure.test.ts`, `test/browser-app-client-shell.test.ts`, `test/browser-reading-log-pure.test.ts`

**Interfaces — Consumes:** `getLocalDayRangeBounds`. **Produces:** view `{ id: 'last-7-days', kind: 'last-7-days', title: 'Last 7 Days' }` listed directly after Today; `isTimeWindowView(view)` true for both; `getViewDayBounds(view, now)` returns the 1- or 7-day range.

- [ ] Step 1: Tests: `buildFeedViews lists Last 7 Days after Today with its unread count`; `readingLogView names last-7-days`; runtime `Last 7 Days view requests since/before for seven local days and lists newest first` (harness with fixed `now`, asserting the `/api/v1/browser/articles` URL has `since` = local midnight six days back and `before` = next midnight, `sort=newest`).
- [ ] Step 2: Run them — fail.
- [ ] Step 3: Implement. Last 7 Days always loads through `/api/v1/browser/articles` with `since`/`before` (the browser-articles path), not the GReader Today path. Generalise Today's special cases into `isTimeWindowView`/`getViewDayBounds` where they are about the window (bounds, boundary stop, count refresh with its own stored day, empty-state "Loading", no default selection, summary text "Received in the last 7 days"); leave Today-only GReader paging alone. Count: `/api/v1/browser/articles/count?stream=all&filter=unread&since&before` with the 7-day bounds.
- [ ] Step 4: `npm test` — pass. Commit `feat(web): Last 7 Days view`.

### Task W3: Folder sections in the stream column

**Files:** Modify `src/browser-app.ts` (`folderSortOrder` :603/:1453/:2835, sort options :2814, `renderArticles` :2852-2997, `createFeedGroupHeader` :2999, impressions `sampleImpressions` :1572 / `noteCardChosen` :1625, j/k `getSelectedItemIndex` :2379), `src/browser-app-styles.ts` (`.article-feed-header` :674-688 plus new section header and "N more" button), Test `test/browser-app-client-shell.test.ts` (rewrite `folders open By feed with a label per feed…` :1247)

**Interfaces — Consumes:** `buildFolderSections`.

- [ ] Step 1: Rewrite the test as `folders open as Today, Last 7 Days and feed sections with N more`: a folder fixture with stories today, 3 days ago and 10 days ago across three feeds; assert header order and titles, a today story rendered in both Today and its feed section, Today rows showing the feed name and feed-section rows not, "N more" expanding a section in place, the folder request using `sort=newest`, and no sort select for folders. Add `j/k walks each story once in display order of first appearance in a folder` and `impressions count a story shown twice once, at its first position, with metadata.section`.
- [ ] Step 2: Run — fail.
- [ ] Step 3: Implement. Folders request `sort=newest`; remove the `'feed'` option and `folderSortOrder`; keep the read filter. Section headers reuse the `.article-feed-header` look (hairline, favicon for feed sections, clickable → opens that feed view); "Older" and "Today"/"Last 7 Days" headers are text-only. Rows keep `data-item-id`; both copies get `is-active`. Keyboard and impressions walk `uniqueDisplayOrder` (first appearance). Impression metadata adds `section: 'today' | 'last-7-days' | 'feed'`. The expanded-section set is per folder for the page session.
- [ ] Step 4: `npm run check` — pass. `npm run visual:check` — pass, no console errors. Commit `feat(web): folder sections in the Reeder look`.
- [ ] Step 5: Update `DESIGN.md` Web section (folder sections, Last 7 Days) and commit `docs: web folder sections in DESIGN.md`.

---

## Part 2 — iOS (branch `claude/ios-folder-cards` from `origin/main`, worktree `../pigeon-ios-cards`; cherry-pick the spec and this plan)

Order: I1 → I2 → I3 → I4 → I5 (Cards look PR), then I6 (Last 7 Days view) in the same branch as a separate commit series; split into two PRs if the diff passes ~1500 lines.

### Task I1: Day windows and `FolderSections` model

**Files:** Modify `Core/ReaderLocalDayBounds.swift`; Create `Core/FolderSections.swift`; Test `PigeonReaderTests/Core/FolderSectionsTests.swift`

**Interfaces — Produces:**
- `ReaderLocalDayBounds.localDays(_ count: Int, endingWith date: Date, calendar: Calendar = .autoupdatingCurrent) -> Self` (start = midnight `count-1` days before, end = next midnight).
- `nonisolated struct FolderSections: Equatable, Sendable { struct Section: Equatable, Identifiable, Sendable { enum Kind { case today, lastSevenDays, feed, older } let id: String; let kind: Kind; let title: String; let feed: ArticleFeedDirectory.Feed?; let articles: [Recommendation]; let hiddenCount: Int }; let sections: [Section]; let uniqueArticleIDs: [String] }` with `static func make(articles: [Recommendation], feeds: ArticleFeedDirectory, now: Date, calendar: Calendar = .autoupdatingCurrent, expanded: Set<String> = []) -> FolderSections`. Limits 5 / 5 / 3 as `static let`. Ids `today`, `last-7-days`, `feed:<feed.id>`, `older` (header-only section, empty articles).
- `FeedDaySections.make(articles:now:calendar:expanded:)` returning the same `Section` type with kinds today / yesterday / earlier (add cases `yesterday`, `earlier`) for a single feed.

- [ ] Steps: failing Swift Testing tests mirroring W1 (same instants, DST in America/New_York, duplicates, unknown feed, limits, expanded) → implement → `xcodegen generate` → run `-only-testing:PigeonReaderTests/FolderSectionsTests` → commit `feat(ios): folder sections model`.

### Task I2: `ReaderLook` setting with migration

**Files:** Modify `Core/ReaderTypographySettings.swift` (:71-83, :121, :158, :234-240), `App/PigeonReaderApp.swift:33`, `Core/ReaderCompactArticlePresentation.swift` (:22-38), `App/ReaderShellView.swift` (:77-83, :135-140), `Features/Reader/ArticleListToolbar.swift` (:46-79, :138-147), `Features/Settings/SettingsView.swift:137-142`; Tests `ReaderTypographySettingsTests.swift:50-67`, `ReaderCompactArticlePresentationTests.swift:71-97`

**Produces:** `enum ReaderLook: String, CaseIterable { case cards, reeder }`, titles "Cards"/"Reeder"; `ReaderTypographySettings.look`. Cards navigates like Front Page did on iPad (`navigationSizeClass` returns `.compact` for a regular window in Cards); Reeder keeps the split view. The Display menu picker and Settings picker (`home-layout-picker` id kept) switch the look; the folder sort menu is hidden in Cards when `collection.kind == .folder || .feed`.

- [ ] Steps: tests `lookMigratesFrontPageToCardsAndClassicToReeder`, `lookDefaultsToCardsWithoutAStoredLayout`, `cardsNavigatesCompactInARegularWindow` → fail → implement (rename `usesFrontPage` call sites to the look; smart views in Cards still use `FrontPageView`, in Reeder the List) → unit tests pass → commit `feat(ios): Cards and Reeder look setting`.

### Task I3: `FolderCardsView`

**Files:** Create `Features/Reader/ReaderTiles.swift` (move `ReaderHomeTileStyle`, `ReaderHomeTileButtonStyle`, `ReaderHomeFeedIcon` and the colour bar out of `ReaderHomeTilesView.swift`, made internal); Create `Features/Reader/FolderCardsView.swift`; Modify `Features/Reader/ArticleListView.swift` (third branch at :135 for Cards + folder/feed; the impression/pagination wiring mirrors `frontPage(...)` :438-490, `viewport: nil`); Modify `App/ReaderAppModel.swift` (add `folderColorIndex(for folderID: String) -> Int?` using `ReaderHomeTiles.colorIndices` over all folder ids; Home tiles call the same helper); Test `PigeonReaderTests/Features/FolderCardsTests.swift`

**Interfaces — Consumes:** `FolderSections`, `FeedDaySections`, `folderColorIndex`. `FolderCardsView` takes the same callbacks as `FrontPageView` (`select`, `onNearEndChange`, `onUserScroll`, `onScrollingChange`, `onStoryVisibilityChange`, `storyMenu`, `footer`) plus `sections: FolderSections`, `colorIndex: Int?`, `onExpand: (String) -> Void`, `onOpenFeed: (ArticleFeedDirectory.Feed) -> Void`.

Card: `ReaderHomeTileStyle` background and shape, 3pt leading bar in the folder colour, header (Today/Last 7 Days in kicker type; feed cards favicon + feed name, tappable to open the feed), stories in `ReaderTypography.storyTitle` with one `.caption` meta line (Today/Last 7 Days rows add the feed name in kicker type and the feed's kicker colour), read stories by weight and colour, "N more" button. No swipe actions; context menu from `storyMenu`. Wide windows: feed cards in a `LazyVGrid` with `ReaderHomeTiles.folderColumnCount`, Today and Last 7 Days full width, content capped at `ReaderHomeTiles.maximumContentWidth`; one column at accessibility sizes. Impressions: `impressions.updateRows(sections.uniqueArticleIDs)`; a story is visible while any copy is.

- [ ] Steps: tests on the view model glue (`expandingASectionShowsEveryLoadedStory`, `uniqueIDsFollowFirstAppearance`, `folderColorMatchesHomeTile`) → fail → implement → `xcodegen generate` → unit tests pass → manual check on `Pigeon Claude` (light, dark, sepia, an accessibility size, iPad simulator in both orientations) → commit `feat(ios): folder cards`.

### Task I4: All Feeds tiles

**Files:** Create `Features/Reader/ReaderLibraryTilesView.swift`; Modify `Features/Reader/ReaderHomeView.swift:24-51` (Cards shows the tiles; Reeder and `PIGEON_UI_TEST_HOME=list` keep `ReaderSidebarView`); extract the folder/feed context menus and confirmation dialogs from `ReaderSidebarView.swift` (:79-88, :212-246, :263-295) into a shared `ReaderLibraryItemMenus` used by both; Test `PigeonReaderTests/Features/ReaderLibraryTilesTests.swift`, UI `PigeonHomeTilesUITests.swift`

Contents top to bottom: views as tiles including Unread; each folder tile followed by its feeds as smaller tiles (favicon, name, newest cached headline); a "Feeds" group for feeds in no folder. Respects `model.sidebarFilter`; `ReaderLibraryToolbarItems`; pull to refresh; ⌘-number shortcuts; identifiers `reader-sidebar-item-<id>` on tiles; Home button `reader-home-show-tiles`.

- [ ] Steps: model test `libraryTilesListViewsFoldersWithFeedsThenUnfiledFeeds` (a pure `ReaderLibraryTiles.make(snapshot:navigation:cachedArticles:)` like `ReaderHomeTiles.make`) → fail → implement → update `PigeonHomeTilesUITests` (All Feeds now shows tiles, Home button returns) → run that UI class plus unit tests → commit `feat(ios): All Feeds as tiles in Cards`.

### Task I5: UI tests, DESIGN.md

**Files:** `PigeonReaderUITests.swift:936-969` (`testDisplayMenuSwitchesBetweenFrontPageAndClassic` → `…BetweenCardsAndReeder`), `PigeonDeviceLayoutUITests.swift` (:72-80, :123-213), `DESIGN.md` iOS section, `.github/ios-smoke-ui-tests.txt` only if a listed test is renamed.

- [ ] Steps: update tests → run `-only-testing:PigeonReaderTests -only-testing:PigeonReaderUITests/PigeonHomeTilesUITests -only-testing:PigeonReaderUITests/PigeonDeviceLayoutUITests` plus the renamed test → pass → update `DESIGN.md` (Cards/Reeder, folder cards, All Feeds tiles, remove the Classic/Front Page setting text) → commit.

### Task I6: Last 7 Days view (iOS)

**Files** (from the research): `Core/ReaderSection.swift` (case `lastSevenDays`, title "Last 7 Days", `systemImage` "calendar.badge.clock", `apiValue` "last-7-days", ⌘6), `Core/ReaderNavigationItem.swift:40`, `Core/ReaderNavigationCatalog.swift:86-100`, `Core/ReaderNavigationState.swift:23-37` (add the missing row to cached navigation), `Core/ReaderSmartViewStore.swift` (on by default; migrate stored settings like Unread at :50-62), `Core/PigeonAPIClient.swift` (count in `navigationSnapshot` via `unreadCount(on:)` with the 7-day bounds; stream via `recommendationsPage` with those bounds), `Core/ReaderAPIModels.swift` (`ReaderNavigationSmartCounts.lastSevenDays` with default 0), `App/ReaderAppModel.swift` (every `.today` site the research lists that is about the window: `streamDayBounds`, load/load-more, pruning at midnight, count updates, the exhaustive switch at :4840), `Core/OfflineLibraryStore.swift` + `Core/OfflineLibraryBootstrap.swift` (membership and rollover mirroring Today, keyed to the same `todayDayStart`), `Features/Settings/SettingsView.swift:63-71`, `Features/Reader/ReaderHomeTiles.swift` (five view tiles: phone 3 columns, wide one row of 5), `Features/Reader/ArticleListView.swift` (:515, :673, :693), `Features/Reader/ReaderCollectionPane.swift:48`.

- [ ] Steps: failing tests copying the Today ones (`ReaderNavigationTests.localTodayUsesInclusiveStartAndExclusiveNextMidnight` → `lastSevenDaysUsesSixDaysBackToNextMidnight`; `OfflineLibraryBootstrapTests.staleTodayCountIsZeroed…` → last-7-days variant; `ReaderAppModelTests.todayHidesYesterdayStoriesAfterLocalMidnight` → `lastSevenDaysDropsStoriesOlderThanTheWindowAfterMidnight`; `ReaderSmartViewSettingsTests` migration; `ReaderHomeTilesTests` five-tile columns; `SavedItemsTests`-style cached-navigation test) → implement → full unit suite → commit `feat(ios): Last 7 Days view`.

### Final (each PR)

- [ ] Full checks: web `npm run check` + `npm run visual:check`; iOS unit suite plus touched UI classes on `Pigeon Claude`.
- [ ] Ship per `CLAUDE.md`: PR, CI green, `/code-review` and fixes, `Workstream reviewed head` status, merge commit, main green.
