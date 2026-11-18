# iPad parity, UI bugs and performance, 2026-11-18

Branch `claude/funny-allen-kd1ox1`, cut from `origin/main` 8115b24. No pull request.

## Where verification stands

The work was written in a Linux container with no Swift toolchain. It was first compiled and run on 2026-11-18 at 12:53 UTC, by run 9 of the new `iOS device layout` workflow on the self-hosted Mac (Debug build, iOS 26.5 simulators).

Verified by run 9:
- The branch compiles in Debug. The Release build has not been tried.
- 1,048 of 1,049 unit tests passed. The one failure was a new test calling the store directly and getting a protocol default; fixed in 14f24bc and not yet re-run.
- `PigeonHomeTilesUITests` (4 tests) passed on the iPhone 17 Pro and on an iPad Pro 11-inch. The two iPad-only tests that CI always skipped (`testIPadLandscapeStartupShowsSavedHomeAndRestoresStories`, `testSwitchingFeedsKeepsTheRegularSidebarStationary`) ran and passed on the iPad Pro.
- The layout walk completed on the iPhone in both orientations and on the iPad Pro in portrait: Home, library, Classic list, Settings, Front Page, reader, Home from an open story and back, rotation, reading controls. It recorded no control cut off by the window, no small bar button and no overlapping bar buttons on any screen.
- Measured frames on the iPad Pro 11-inch: in portrait the list column is 340pt and the reader 494pt; in landscape the sidebar is 280pt and the reader 580pt. The Home button is hittable in the list toolbar.

Not verified:
- **No screenshot has been looked at.** They are in the run's artifact (`pigeon-device-layout-<run>`), 60 files for run 9.
- **iPad mini**: no run yet. The workflow tried to create an iPad mini 4 simulator, which iOS 26.5 refuses; fixed in 14f24bc.
- **iPad Pro in landscape**: the walk stopped at its first tap, because Home covers a sidebar whose rows share identifiers with the tiles and the test tapped an ambiguous match. The test is fixed in 14f24bc. The duplicate elements under Home are real for VoiceOver and predate this branch.
- **The wide tile grid**: the sample library has two folders, so run 9 could not tell two columns from three. The walk now checks tile width instead.
- The Release configuration, the full UI suite, and a warning-free build log (CI fails on first-party warnings; the workflow's filter does not print them).

Run 10 was requested with those fixes. Earlier runs (2, 5, 8) were picked up while the laptop was briefly awake and failed ten minutes later with no log; the workflow now holds the Mac awake with `caffeinate` while it runs.

### Measured (run 9, simulator on the Mac, Debug)
From `statusTogglePathBenchmark`, 150 stories with 38 KB bodies:

| | ms |
|---|---|
| First save of the collection (what every re-save used to cost) | 2,190 |
| Re-save of the same collection (what a read or star toggle does now) | 80 |
| Decode the whole collection (what every status change used to do first) | 29 |
| Enqueue one read mutation now | 1.8 |
| Sanitize one 38 KB body now | 14.3 |
| Regex compilations removed from that sanitize (880 opening tags) | 7.6 |

So the collection re-save is about 27 times cheaper and the enqueue no longer scales with the library. The sanitizer itself only went from about 22 ms to 14 ms per body: its remaining cost is the character-by-character scan, which is the next thing to fix on that path. The existing `CACHE_BENCH` reported 474 ms to load 5,344 stories (61.5 MB of payloads) with the new parallel decode; there is no before number from the same machine.

## What changed

### iPad parity with iPhone
- **Home is the tile grid on iPad.** A regular-width window opened on a full-screen library list; it now opens on the same tiles as iPhone, with the views on one row and folders three or four across, capped at 960pt. "All Feeds" still swaps to the list. `ReaderHomeView.Placement`, `ReaderHomeTiles.folderColumnCount`.
- **A way back to Home.** A split view has no stack to pop, so once a view was chosen an iPad could not return to Home without relaunching. The list column's toolbar has a Home button on regular width (`ReaderHomeToolbarItem`, `ReaderAppModel.showHome()`).
- **Front Page on iPad.** It was gated on a compact size class. It is now the reader setting it is on iPhone, the Layout picker shows on every width, the page is capped at 640pt, and a column under 330pt gets a one-column grid.
- **Column widths.** Sidebar 240-320 (ideal 280) and list 300-400 (ideal 340) instead of the system's 320 and 375, which left an iPad mini in portrait a narrower reading column than an iPhone.

### UI bugs fixed
- The story list decided "the reader covers me" from its own column's size class. If that column reports compact on iPad (the sidebar does; the list column was not checked on a device), updates, the new-stories pill and paging stall for as long as a story is open. The list, Read It Later and the feed-switch fade now ask the window.
- Next and previous article shortcuts (J and K by default, no modifier) acted behind Settings, Add Feed and Home.
- With Home covering an open story on iPad, reading time kept accruing and a video kept playing.
- The undo banner spanned all three iPad columns; it is capped at 560pt like the status banner.
- List metadata wrapped under itself in a narrow column; the reader header put a long feed name and a long date on one line. The first stays on one line, the second stacks when it does not fit.
- A 3:2 Front Page lead image at full width is taller than an iPhone in landscape; a compact-height window crops it to 21:9.
- A sync that changed the library cleared a search in progress (item 4 of "Act on first" in `tasks/bug-hunt.md`): the list's load task ran again and reset the field. Only a list's first load does that now.
- Reopening Personalization and adding a topic before the saved topics had reloaded replaced every topic on the server with the new one (item 5 there). Add and Remove wait for the load.

### Performance
Each item names what the work scaled with before and after. N is cached stories (about 6,700 in `tasks/todo.md`), B the average body (about 39 KB).

| Path | Before | After |
|---|---|---|
| Read or star a story (also every open, since Mark Read defaults to On Open): find the rows to update | decode every cached story's JSON, body included: N x B | read four small columns per row, decode only rows whose status changes |
| Same toggle: save each collection holding the story | sanitize, encode and rewrite every story in each of those collections | hash each body; sanitize only bodies not seen before; write only rows that differ |
| HTML sanitizer (every save, sync and open) | one regex compilation per opening tag | three expressions compiled once; tags without attributes and values without `&` skip their passes |
| Sync page, story-body page, For You page | JSON decoded on the main actor, two date formatters allocated per date | decoded in a detached task with shared formatters |
| Sync merge: which collections does a page touch | every cached row scanned, and a set built, per change | one alias index per page |
| Sync merge: copy shared fields into other collections | every collection rewritten whether or not a row changed | written only when a row changed |
| Sync that includes an RSS refresh (the server emits a feed change for every refresh, changed or not) | whole library decoded and every list reloaded | a feed change that repeats the cached feed is ignored for the reload |
| Cold launch: full library load | stories decoded one by one on the store's actor | batches of 128 decoded on every core |
| Relaunch, first open of each collection | first page of bodies downloaded again, because `contentVersion` was dropped on save | version stored with the body, so unchanged bodies are reused |
| Open a story | body sanitized twice at utility priority | once, at user-initiated priority |
| Thumbnail download | cancellation check and `Data` append per byte | per 32 KB |
| Thumbnail memory cache | 24 images / 4 MB (under two Front Page leads) | 64 images / 16 MB |

On "10x": the first two rows are where an order of magnitude was plausible and is now measured (see above). The sanitizer gained about 1.5x, not several-fold. The sync merge, the repeated-feed reload and the rest are unmeasured.

## Not fixed

### UI, from the code review (unverified on a device)
1. **Rotating or resizing across the compact/regular boundary rebuilds the reader.** `ReaderShellView` hosts the story in the detail column on regular width and in a separate stack on compact. The switch restarts every `.task`, so the open is recorded again, a story marked unread is marked read again (On Open), open sheets close and video restarts. Fix: record an explicit open once per selection in the model, and host the reader in one place.
2. **The reader's navigation bar may ignore the reader theme on iPad.** The theme's colour scheme is applied to content only (`ReaderThemeColorSchemePlacement.environmentOnly`), so Sepia under system Dark could show a light title on a cream page. Needs eyes on a device before choosing between `toolbarColorScheme` and a bar background.
3. **Returning to a feed on iPad reopens its remembered story** in the detail column without a tap, and that counts as an explicit open (`reconcileSelection`, `isReadingOpenArticle` is false on regular width).
4. **Reading controls and the image viewer are iPhone sheets on iPad**: a centred form sheet over the text being adjusted, and a small card for a zoomable image.
5. **Confirmation dialogs anchor to whole containers on iPad** (`ArticleBodyView.swift`, `ReaderSidebarView.swift`, settings screens), so the popover does not point at what was tapped.
6. **Trackpad scrolling cannot pull to the next or previous story** (`ReaderBoundarySwipeRecognizer` has no `allowedScrollTypesMask`). No hover effects anywhere.
7. **The undo banner still sits over the reader's bottom bar** for six seconds after Mark Read on iPhone. Only its width was changed.
8. Possible: article CSS mixes `prefers-color-scheme: dark` colours into a light reader theme on iPad (`StructuredHTMLJavaScript.swift`), if the web view does not inherit the environment-only scheme.

### Performance, in order of expected return
1. **Optimistic UI before the store.** `applyArticleState` updates the screen only after `await enqueueOfflineMutation`. The store is now quick, but a tap during a sync still waits for the actor. Move the in-memory change first and roll back if the enqueue fails.
2. **First list after a cold launch still waits for the whole library.** Load the selected collection with the existing scoped `loadSnapshot(accountID:collectionIDs:)`, publish it, then hydrate the rest. Longer term, keep bodies out of list rows.
3. **For You downloads its whole ranked pool on every load**: up to 22 sequential pages of 50 bodies, nothing shown until the last. Publish page one first, or add a body-less, versioned mode to the endpoint (additive, for the TestFlight build).
4. **Every story opens in a brand-new web view** with a fresh data store, shell load and font install. Keep one warm `WKWebView` and swap content; needs `webViewWebContentProcessDidTerminate`.
5. **Server: stop writing no-op feed sync rows** with `WHEN OLD.x IS NOT NEW.x` on `trg_sync_feed_update` at the next schema bump. The app now tolerates them, but the store still redoes per-feed work for each.
6. `articleCache` is one observed dictionary, so a write to any collection invalidates the shell, Home, the list and the reader. Per-collection storage and an alias index for `article(withId:)` would cut re-renders.
7. Offline search decodes every payload per query; SQLite FTS5 would replace it.

## The device layout workflow
`iOS device layout` (`.github/workflows/ios-device-layout.yml`, `docs/ci-validation.md`) is new and on demand. CI only ever picked iPhone simulators, so no regular-width path has been tested by CI, including the two iPad-only tests that have always been skipped. The run also includes the Home tile tests and those two iPad-only tests. `PigeonDeviceLayoutUITests` walks Home, the library list, a story list in Classic and Front Page, Settings, the reader, Home again from an open story, a rotation and the reading controls, in both orientations, and records a screenshot and element frames per screen.

The workflow has a temporary `push` trigger on `.github/ios-device-layout.request`, so this branch could request runs before the file is on `main`. Remove the trigger and the request file before merging; `workflow_dispatch` is the lasting entry point.

## Handing off to a session on the Mac
The simulator pane in Claude Code Desktop (`code.claude.com/docs/en/desktop-ios-simulator`) exists only in a local session on the Mac, which is why no screen has been looked at. Open the Code tab in Claude Desktop with this repo as the project folder and paste:

```text
Finish the work on branch claude/funny-allen-kd1ox1. Follow CLAUDE.md (worktrees, the Pigeon Claude simulator, never cancel a running iOS job).

1. git fetch origin, then git worktree add ../pigeon-ipad-parity claude/funny-allen-kd1ox1. Read tasks/ipad-and-performance-2026-11-18.md in full: what changed, what run 9 verified and measured, what is open.
2. See how the latest "iOS device layout" run went: gh run list --workflow ios-device-layout.yml --branch claude/funny-allen-kd1ox1 --limit 3, then gh run view <id> --log | grep -E "PIGEON-LAYOUT|_BENCH|error:|recorded an issue|Test Case .* failed|\*\* TEST". If it is still running, wait; never cancel it. Fix what it reports.
3. Locally: xcodegen generate in ios/PigeonReader, run the unit tests, then a clean Release build and .github/scripts/fail-on-first-party-warnings.sh on its log. Release and warnings have not been checked.
4. Look at the screenshots nobody has seen: gh run download <id> -n pigeon-device-layout-<id>-1. Then check the app in the iOS Simulator on an iPhone 17 Pro, an iPad Pro 11-inch and an iPad mini, portrait and landscape, launched with -reader-sample-data -reader-show-sidebar -reader-reset-reader-state -reader-folder-read-data: Home tiles, All Feeds and back, a Classic list, Display > Layout > Front Page, an open story, the Home button from an open story on iPad and back, Settings, Reading controls in Sepia and Dark Gray with the system in Dark. The sample library has two folders, so judge the wide tile grid by tile width (about 260pt at three across on an 834pt iPad).
5. Go through "Not fixed" in the tasks file on the iPads. Tell me what looks wrong before redesigning anything; fix what is plainly a bug. Known from run 9: on iPad in landscape the split view's sidebar stays in the accessibility tree under Home.
6. Before a pull request: remove the temporary push trigger from .github/workflows/ios-device-layout.yml, delete .github/ios-device-layout.request, update the tasks file with what you verified. Do not open the pull request until I ask.
```
