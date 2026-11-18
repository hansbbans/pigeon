# iPad parity, UI bugs and performance, 2026-11-18

Branch `claude/funny-allen-kd1ox1`, cut from `origin/main` 8115b24. No pull request.

## Read this first: nothing here has been compiled

The session ran in a Linux container with no Swift toolchain, and the self-hosted Mac was asleep for almost all of it. It picked up one job at 04:06 UTC and dropped off ten minutes later with no log, and has not taken a job since. So:

- No Swift in this branch has been through a compiler, a unit test or a simulator. It was written against the existing code, re-read, and reviewed once by a second read-only pass that was asked to act as the compiler. That pass found one real error (store counters declared inside `#if DEBUG` and used outside it, which would have broken only the Release build), now fixed. It will not have found everything.
- No screen was looked at. The UI findings are from reading code.
- The timings under Performance are complexity arguments, not measurements. A benchmark test prints real numbers the first time the unit tests run.

One run of the new `iOS device layout` workflow is queued for the branch head and will start when the Mac wakes. It builds, runs every unit test once, and runs the layout walk on three simulators. Its last step prints compile errors, failed tests, `_BENCH` timings and one line per screen with element frames. Read that log before anything else here is trusted. `PigeonReader.xcodeproj` is not regenerated: one test file was added, so run `xcodegen generate` (the workflow's last step prints the diff).

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

On "10x": the first two rows are where an order of magnitude is plausible for something a reader does constantly, because the old cost grew with the whole library and the new one with the one story touched. The sanitizer, the sync merge and the repeated-feed reload are likely several-fold. The rest are smaller or remove main-thread stalls rather than total work. None of it is measured yet.

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

## Checking this in the iOS Simulator pane
The guide for this work is Claude Code Desktop's simulator pane (`code.claude.com/docs/en/desktop-ios-simulator`). That pane exists only in a local Desktop session on the Mac; a cloud session cannot reach the simulators, which is why none of the above has been looked at. To do the check, open the Code tab in Claude Desktop on the Mac with this repo as the project folder and paste:

```text
Fetch origin and check out claude/funny-allen-kd1ox1 in a worktree (git worktree add ../pigeon-ipad-parity claude/funny-allen-kd1ox1). Read tasks/ipad-and-performance-2026-11-18.md first: nothing on this branch has been compiled.

1. In ios/PigeonReader run xcodegen generate, then build. Fix compile errors and warnings (CI fails on first-party warnings), then run the unit tests on the Pigeon Claude simulator and fix failures. Report the STATUS_TOGGLE_BENCH and SANITIZER_BENCH lines the tests print.
2. Run the app with -reader-sample-data -reader-show-sidebar -reader-reset-reader-state -reader-folder-read-data on the iPhone 17 Pro simulator, then the iPad Pro 11-inch simulator, then the iPad mini simulator. On each, in portrait and landscape, look at: Home tiles; All Feeds and back; For You in Classic; Display > Layout > Front Page; an open story; the Home button from an open story (iPad) and back into the list; Settings; the reader's Reading controls in Sepia and Dark Gray with the system in Dark.
3. Check the unverified items under "Not fixed" in that file on the iPads: reader navigation bar colours under each theme, rotating with a story open, the undo banner over the reader's bottom bar, the confirmation dialogs' popover anchors, the reading-controls sheet and the image viewer.
4. Tell me what looks wrong before changing any layout, then fix what is clearly a bug and commit to this branch.
```
