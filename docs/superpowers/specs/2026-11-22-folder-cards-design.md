# Folder cards: one card language past Home (iOS)

Date: 2026-11-22. Status: draft for Hans's approval.

Two parts, one PR each, in this order: **Part 1** folder cards and the All Feeds tiles; **Part 2** a Last 7 Days view on Home.

## Intent

Home on iOS is a card grid: tiles of `secondarySystemGroupedBackground` on `systemGroupedBackground`, radius 12 continuous, each folder with its kicker-colour bar, its newest headline in the reading typeface, and favicons (`ReaderHomeTilesView.swift`, `ReaderHomeTiles.swift`). One tap further, the app stops looking like Pigeon:

- A folder opens as either the Front Page (newsprint, colours per feed, so the folder's colour disappears) or the Classic `List` (stock rows with small grey `ArticleFeedSectionLabel` headers).
- "All Feeds" swaps Home for `ReaderSidebarView`, a stock iOS sidebar with "Views"/"Folders" sections and disclosure arrows.

What Hans dislikes: **the screen looking like stock iOS.** Inside a folder he prefers stories **grouped by feed**, not one combined stream, with **one Today card on top**. The goal is one card language from Home through folders and the library, so tapping a tile opens more of the same thing.

## Goals

1. A folder opens as a column of cards on the grouped background, in the same style as the Home tiles:
   - **Today card** first: every story in the folder received since local midnight, newest first. Each story shows its feed name (kicker type, the feed's kicker colour) over the headline, because the card mixes feeds. Shows the first 5, then "N more" expands the card in place. No Today card when nothing arrived today.
   - **Last 7 Days card** second: the folder's stories from yesterday back through the 6 days before it (local days), newest first, feed name over each headline, 5 then "N more". It leaves out today's stories, which sit in the card right above it. No card when that window is empty. The title is "Last 7 Days" (Hans's name for it).
   - **One card per feed** after it: header with favicon and feed name, then that feed's newest 3 to 5 stories as `story-title` headlines with one caption meta line (time, reading length, paywall label as today). Stories in the Today and Last 7 Days cards **also appear** in their feed's card (Hans chose this so each feed card reads as that source's own front, predictably).
   - Feed cards are ordered by each feed's newest story, most recent first. Feeds whose newest loaded story is older than 7 days sit under a quiet "Older" header at the bottom.
   - Every card carries the folder's kicker colour as its 3pt leading bar, the same colour as the Home tile that opened it.
2. "All Feeds" becomes a tile grid in the Home style instead of the stock sidebar: a tile per folder (as on Home) and, under each folder, its feeds as smaller tiles (favicon, name, newest headline). No disclosure arrows.
3. iPad and other wide windows: feed cards go 2 or 3 across with the Home tile rules (`ReaderHomeTiles.folderColumnCount`, content capped at 960pt and centred). The Today and Last 7 Days cards span the full width.

4. **Part 2: Last 7 Days view.** A new smart view, `ReaderSection.lastSevenDays`, beside Today: every feed's stories from the last 7 local days *including today*, newest first. It is built the way Today is, from the reading-list stream with time bounds (`ReaderLocalDayBounds`, `PigeonAPIClient.recommendations(from:dayBounds:)`), so no Worker change. It needs everything Today has: offline collection membership and day rollover in `OfflineLibraryStore` / `OfflineLibraryBootstrap`, a smart count, a Home tile, a library tile, a Smart Views toggle in Settings (on by default), a keyboard shortcut (⌘6), and a reading-log list name. Home then has up to five view tiles; the builder extends `ReaderHomeTiles.viewColumnCount` for five (three over two on a phone).

## Non-goals

- Smart views (For You, Today, Last 7 Days, Read It Later, Starred, Unread) keep the Front Page or Classic presentation. They can follow later once folders feel right.
- The reader (article page) and the web app are unchanged. The web app gets no Last 7 Days view in this work.
- No new server API. Everything comes from the folder's existing paginated stream and the navigation items.

## Anti-goals (a failure even if it works)

- Anything that reads as Mail: sender/subject/preview rows, unread dots as the organising idea, swipe-to-triage as the main interaction. Cards have no swipe actions; the per-story context menu (read, star, mark above/below) stays.
- Stock grouped-`List` chrome (inset-grouped section headers, disclosure chevrons, `.sidebar` list style) on these screens.
- Unread counts as the headline of a card. Counts may appear only as the quiet "N more".
- Colours that change between Home and the folder: a folder's colour comes from the same `ReaderHomeTiles.colorIndices` assignment everywhere.

## Constraints

- Design rules in `DESIGN.md` (tokens, 4.5:1 contrast in every theme, Dynamic Type through `ReaderTypography`, Reduce Motion through `ReaderMotion`, radius 12 continuous for cards, no custom shadows). One column of cards at accessibility sizes.
- Folder streams are paginated (`loadMoreControls`, `articleCache`). Cards are built from the loaded stories; reaching the end of the scroll loads the next page as now, which may add stories to existing cards and add new feed cards. Cards must not jump under the reader's finger when a page lands (append below, or hold updates the way the list does with `holdsUpdates`).
- The reading-log experiment is live until about 2026-12-16 (`docs/reading-log.md`). Card stories must keep recording impressions and opens through `ReaderImpressionRecorder` (`rowChosen`, row visibility), with metadata that marks the new presentation (for example `metadata.row = "card"`) so the report can separate it.
- Selection, `retainPresentedArticles`, mark-read-on-scroll behaviour (`ReaderMarkReadBehavior`) and saved scroll position per folder must keep working.
- The library actions now only in `ReaderSidebarView` must survive on the tiles: Rename/Delete Folder, Open/Edit/Rename Feed, Unsubscribe (context menus), the Unread filter (`sidebarFilter`), add feed/folder (`ReaderLibraryToolbarItems`), pull to refresh, and keyboard shortcuts on iPad.
- UI tests: `PIGEON_UI_TEST_HOME=list` starts tests on the library list (`ReaderHomeView.startsOnLibraryList`), used by four UI test files; smoke tests are listed in `.github/ios-smoke-ui-tests.txt`. Accessibility identifiers (`ReaderSidebarAccessibility.item(...)`) must stay or the tests move with them.
- Worker CLAUDE.md iOS rules: `xcodegen generate` after adding files; test on the `Pigeon Claude` simulator.

## Approaches considered

- **A. Carry the cards through (chosen).** Folder and All Feeds reuse the Home tile vocabulary. Keeps the part Hans likes and removes stock iOS from the path. Cost: fewer stories per screen than a list; a busy feed needs "N more".
- **B. Newspaper sections.** Folder becomes a Front Page with a ruled section per feed; All Feeds a contents page. More editorial, but Home stays cards, so the jump from cards to newsprint remains. Rejected.
- **C. Restyle the Classic list.** Custom rows and coloured feed headers. Cheapest, still reads as a list. Rejected.

Refinement from Hans: a Today card on top of the feed cards, and today's stories repeated in their feed cards.

## Decided

- Approach A, the Today card, repetition of today's stories in feed cards (all Hans).
- Last 7 Days as both a folder card and a Home view (Hans). The folder card leaves out today because the Today card sits above it; the Home view includes today (Claude's calls).
- Today = since local midnight; feed cards ordered by newest story; "Older" group past 7 days; 5 stories in Today before "N more", 3 to 5 per feed card (Claude's calls, stated to Hans, not objected to).
- All Feeds as tiles; iPad cards 2 to 3 across (Claude's calls, stated to Hans).
- Claude's calls after the builder check, all accepted by Hans:
  - Cards replace Front Page and Classic for folders and single feeds; the layout setting governs only the smart views. Folders lose the sort menu and keep the Unread/All filter.
  - On iPad a folder fills the window and navigates like Front Page (Home → folder → article), via `ReaderCompactArticlePresentation.navigationSizeClass`. The Classic split view remains for smart views.
  - Feed cards expand in place with "N more" like the Today card, loading the next page when the loaded stories run out. Tapping a feed card's header opens that feed on its own, in the same card style with cards by day (Today, Yesterday, Earlier).
  - All Feeds holds, top to bottom: the views as tiles (including Unread, which Home leaves out), then each folder tile followed by its feeds as smaller tiles, then a "Feeds" group for feeds in no folder. It differs from Home by showing every feed.
  - Reading log: a story counts as one impression per visit to the folder, however many cards show it. `metadata.row` is `"card-today"` or `"card-feed"` for the card that recorded it first.
  - The folder's Unread/All filter stays: under Unread, the cards show only unread stories. Under All, read stories stay in place and change weight and colour, as in the Classic list.

## Left to the builder

- View structure (a new `FolderCardsView` beside `FrontPageView` is the likely shape, with a pure, tested `FolderCards.make(...)` model like `ReaderHomeTiles.make`).
- Shared tile styling: extract `ReaderHomeTileStyle` and the colour bar into something both Home and the folder cards use rather than copying.
- Exact story count per feed card within 3 to 5 (by Dynamic Type size and width), image use inside cards (Home tiles use none; a lead thumbnail on the Today card is acceptable if it follows `isEditorialImage` and the remote image policy).
- Motion, using the Home tile motion as the reference.
