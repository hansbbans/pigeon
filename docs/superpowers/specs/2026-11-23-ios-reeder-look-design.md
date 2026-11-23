# iOS Reeder look: Hairline (part 3)

Date: 2026-11-23. Status: approved by Hans and built (branch `claude/ios-reeder-look`). Part 3 of `2026-11-22-folder-cards-design.md`; the structure rules there (Today, Last 7 Days, per feed, Older) apply unchanged.

Mockup: `docs/superpowers/mockups/2026-11-23-ios-reeder-look.html`, option A (Hans picked it).

## Intent

In Reeder, iOS still shows the stock Classic `List` and the stock `.listStyle(.sidebar)` library, which is what Hans objected to ("the screen looking like stock iOS"). Part 3 gives Reeder the web app's look on a phone: a white list, hairlines between rows, small grey uppercase section labels, sans-serif titles with one grey meta line, and a quiet grey library column. Cards keeps the serif, the colours and the tiles, so the two looks are clearly different.

## Goals

1. **Reeder has no Home; it opens on the library** (Hans, 2026-11-23).
   - **iPhone:** the library list is the root, with no button back to tiles.
   - **iPad:** the three-column split view shows from launch. The library is its first column, the first enabled smart view is open in the second, and the second column is the active one. In portrait the three columns do not fit (the story column would be narrower than a phone), so the system shows list and story and the library is behind the sidebar button, as an overlay (found while building; landscape tiles all three).
   - **What goes:** the regular-width Home over the split view (`ReaderHomeView.Placement.regularHome`, `ReaderHomeToolbarItem`, `model.showHome()`). Today that path is Reeder-only, because Cards navigates page by page.
   - **Look switching:** Home tiles exist only in Cards. Switching to Cards from the library lands on Home. Switching to Reeder from Home lands on the library. Switching while a list is open keeps that list open (`columnAfterLookChange`, unchanged).
2. **Folders show the folder sections as a hairline list.** The same `FolderSections` model the cards use, drawn as list sections:
   - **Today**: 5 stories, then "N more".
   - **Last 7 Days**: excludes today, 5 then "N more".
   - **One section per feed**: 3 then "N more", ordered by newest story. The label carries the favicon and feed name, plus a trailing "›" that opens that feed (`select(item:)`; on iPhone, back then returns to the library).
   - **Older**: a plain label over feeds whose newest loaded story is older than 7 days.
   - A story in Today or Last 7 Days also appears in its feed's section, as in Cards.
   - "N more" expands its section in place, as in Cards; it does not fetch. Scrolling to the end loads the next page as today.
   - Folders lose the sort menu (a saved sort is ignored for folders and feeds in both looks); the Unread/All filter stays.
3. **A single feed shows day sections** Today, Yesterday and Earlier, the same `feedToday`/`yesterday`/`earlier` kinds Cards uses, with the sort menu removed. **Smart views** stay one flat list with their sort menu and no sections.
4. **Rows.**
   - Title in the system sans, semibold, 2 lines, paywall label inline after it as today. The reading typeface stays in the article and in Cards.
   - One caption meta line. In mixed lists (Today, Last 7 Days, smart views) it reads: feed name (medium weight), relative time, reading length. Feed and day sections drop the feed name. The author no longer leads the line.
   - The For You explanation line and `ScoreBadge` stay in For You only.
   - Hairline separators (`separator` token) run edge to edge between rows, with none under section labels.
   - The selected row keeps the `tint-soft` fill. Only the copy that was tapped is highlighted, as on the web.
5. **Read rows (web parity).**
   - A story already read when the list opened renders compact: one line, regular weight, secondary colour, meta kept, no thumbnail.
   - A story read while the list is open, or one this list already showed in full earlier in the app session, keeps its height and changes only weight and colour. Nothing jumps under the reader's finger and saved scroll positions stay valid (the web's `fullRowIdsByList`).
   - This replaces today's 0.55 opacity.
6. **Library (Reeder only).** A quiet grey column instead of the stock sidebar:
   - Grey uppercase section labels.
   - Views use grey symbols, not blue tint; feeds use favicons.
   - Counts use secondary colour with tabular digits; zero counts are hidden.
   - The folder disclosure stays leading and rotating, drawn as a small triangle. View and feed rows show no trailing chevron.
   - The selection is a rounded neutral fill (new token), not the system blue.
   - The toolbar holds ＋ (Add Feed) and ⋯ with Filter, Look and Settings (⌘, stays).
   - Kept: context menus (Rename, Delete Folder, Open, Edit, Rename Feed, Unsubscribe), pull to refresh, ⌘1 to ⌘6 and the folder expand/collapse animation.
7. **Kept as is:** swipe actions, context menus (read, star, mark above/below), density settings (Title Only, Compact, Comfortable, Image Rich), keyboard shortcuts, search, the "new stories" button, saved scroll position per list, mark-read-on-scroll, the iPad three-column split.
8. **Dark mode** draws the same structure in the existing dark tokens. Every colour comes from a `DESIGN.md` token (new ones are added there). The mockup's lighter greys (#8e8e93 labels and counts, #aeaeb2 "›") fail 4.5:1, so labels, counts and "›" use `pigeonSecondary`.

## Non-goals

- Cards (Home tiles, folder cards, Front Page) is unchanged.
- The article reader is unchanged.
- The web app is unchanged (part 4 is the web Cards look).
- No server or API change.

## Anti-goals (a failure even if it works)

- Anything that reads as Mail: sender/subject/preview rows, unread dots, swipe-to-triage as the main interaction.
- Stock chrome: the `.sidebar` look, inset-grouped headers, trailing chevrons, blue selection fill, blue icons.
- Per-feed colours or serif titles in the Reeder list; those belong to Cards (that was option B).
- Rows that change height when read under the reader's finger.

## Constraints

- **Story identity.** A story can appear twice in a folder: in Today and in its feed section.
  - Row ids are section plus story (`.id`, swipe and context-menu targets), like the card keys.
  - Viewport anchors (`ReaderListRowAnchor`), saved scroll targets and impressions sit only on each story's first drawn copy.
  - The viewport gets the drawn order of first copies, not the loaded order. Its near-end check reads the last ids it was given, so stories hidden behind "N more" must not count as drawn.
  - Mark above/below counts drawn rows from the copy that was used, as Cards and the web do (`presentedOrder`, generalised from `usesFolderCards` to any sectioned list).
- **Pagination and updates.** Sections are built from the loaded window and rebuilt through `FolderCardsSectionsCache`. Older pages are accepted without the update buffer today, because they append at the bottom. In sections they insert rows into expanded sections, so acceptance compares the drawn rows above the current anchor, not the loaded order.
- **iPad launch.** A launch resets the column to `.sidebar`, which means "Home covers the window". In Reeder on regular width that column becomes `.content`; otherwise impressions, j/k, reading time and the library's selection stay off.
- **Reading log** (live until about 2026-12-16):
  - One impression per story per visit.
  - The metadata matches the web: `section` names the section that showed the story first (feed stories under Older log as feed), and `row = "compact"` marks compact read rows.
  - iOS has only `row` today, so `section` is added to the recorder (with a setter, since viewport mode clears `readingLogRows`).
- **`DESIGN.md`:**
  - Its rules (list titles in serif `story-title`, new list surfaces growing from the Front Page) change: Reeder is the sans list, Cards the editorial one. The iPad Home over the split view and its Home button come out.
  - Contrast 4.5:1 in every theme, Dynamic Type through `ReaderTypography` (new tokens for the Reeder title and section label), Reduce Motion through `ReaderMotion`. Shipped in this PR.
- **UI tests.** The test reset defaults to Reeder (`PigeonReaderApp`), so more tests than the four `PIGEON_UI_TEST_HOME=list` files see the change.
  - Known breaks: `testAllFeedsInReederIsTheLibraryList`, `PigeonDeviceLayoutUITests`, `testCachedStartupShowsSavedHomeAndRestoresStories` (smoke) and `testFolderListsStoriesByFeedByDefault`. Move each to the new behaviour or pin it to Cards, and keep `.github/ios-smoke-ui-tests.txt` in step.
  - New tests: Reeder launches on the library (phone and iPad), and a Reeder folder shows a Today label and a feed label.
  - Library identifiers (`ReaderSidebarAccessibility`) stay.
- **Library internals.**
  - Keep `ReaderSidebarView`'s `List(selection:)`, its `NavigationLink`s (they drive the iPhone push and ⌘1 to ⌘6; hide the chevron, don't remove the link) and its viewport coordination.
  - The coordinator assumes rows at least 44pt tall, so rows keep that minimum height even when drawn tighter.
  - `.listRowBackground` alone does not suppress the system selection fill.

## Approach

Restyle the existing Lists rather than build new views (Claude's call, stated to Hans):
- `ArticleListView` keeps its `List`. Folders and feeds in Reeder draw `FolderSections` in place of `feedSections`, reusing the card path's sections cache, impression rows and drawn order.
- `ArticleRowView` gains the Reeder style. `ArticleFeedSectionLabel` becomes the section label for every kind.
- `ReaderSidebarView` keeps its `List` and coordination with new row, header and selection styling.
- `ReaderHomeView` and the shell drop Home in Reeder.

Rejected:
- A new custom `LazyVStack` list. It would lose swipe actions, the viewport machinery and the UI test hooks for no visible gain.

## Decided

- Hairline (option A) (Hans).
- Reeder drops Home and opens on the library (Hans).
- Claude's calls, to confirm with this draft:
  - Read rows go compact only when read before the list first showed them, remembered for the app session.
  - Titles are sans whatever the reading typeface.
  - Single feeds get day sections.
  - Smart views stay flat with a sort menu.
  - The feed "›" opens the feed from the library's level.
  - The Look picker moves into the library's ⋯ menu.
  - Zero counts are hidden.
  - Labels use `pigeonSecondary`, not the mockup's lighter greys.

## Left to the builder

- Exact sizes. The mockup is at 312pt, so scale it: section label about footnote at 0.8pt tracking, title about subheadline semibold, meta caption.
- Where the compact-on-open set lives: the model, keyed by list context, because `ArticleListView` is rebuilt on every visit.
- Whether the library keeps `.listStyle(.sidebar)` with custom rows or moves to `.plain` (headers then stick), whichever keeps the coordinator and the iPad column intact.
