# iPad parity, UI bugs and performance, 2026-11-18

Branch `claude/funny-allen-kd1ox1`, cut from `origin/main` 8115b24. No pull request yet.

## Where verification stands

The work was written in a Linux container with no Swift toolchain. It has since been compiled and run by the new `iOS device layout` workflow on the self-hosted Mac (Debug build, iOS 26.5 simulators). Run 10 (commit 14f24bc, 2026-11-18 13:20 UTC) is the latest.

Verified by run 10:
- The branch compiles in Debug.
- All 1,049 unit tests pass.
- **iPhone 17 Pro: everything passed.** Both layout walks (8 screens each, portrait and landscape) and the four Home tile tests.
- **iPad Pro 11-inch: everything passed.** Both layout walks (9 screens each), the four Home tile tests, and the two iPad-only tests CI always skipped (`testIPadLandscapeStartupShowsSavedHomeAndRestoresStories`, `testSwitchingFeedsKeepsTheRegularSidebarStationary`).
- The walk recorded no control cut off by the window, no small bar button and no overlapping bar buttons on any screen of either device.
- Measured on the iPad Pro 11-inch: folder tiles are 261pt wide in portrait (three across) and 225pt in landscape (four across); the list column is 340pt and the reader 494pt in portrait; the sidebar is 280pt and the reader 580pt in landscape. The Home button is hittable in the list toolbar, Home covers an open story and the story is still there afterwards, and the reader survives rotation both ways.
- iPhone 17 Pro: folder tiles 180pt in portrait (two across, as before) and 233pt in landscape (three across).

**iPad mini: 7 of 8 UI tests failed in run 10 because the simulator's screen never came up, not because of the app.** All 12 iPad mini screenshots in the artifact are the same black system screen with a white blob (one image per orientation) while the accessibility tree already listed the app's elements, so every tap landed on nothing. That simulator (`iPad mini (A17 Pro) (Pigeon CI)`) had been created in that job. The workflow already waits on `simctl bootstatus -b`, so that wait is not enough on a first boot. Booted again later, the same simulator shows the app normally. The black screen could not be reproduced locally, and the workflow cannot be dispatched again until it is on `main`, so a second CI run on the mini is still owed.

Checked locally on the Mac, 2026-11-18 (Xcode, iOS 26.5 simulators `Pigeon Claude`, `Pigeon Claude iPad Pro 11`, `Pigeon Claude iPad mini`):
- `xcodegen generate` changes nothing. All 1,049 unit tests pass, before and after the two fixes below.
- **Clean Release build succeeds and `.github/scripts/fail-on-first-party-warnings.sh` finds no first-party warnings.** The only warning in the log is Xcode's `appintentsmetadataprocessor` notice.
- On a freshly created iPad mini simulator the branch passes the four Home tile tests and `testSwitchingFeedsKeepsTheRegularSidebarStationary`, and every tap works by hand. There is no hit-testing bug.
- With the two fixes below, the full layout walk passes on that iPad mini simulator (9 screens in each orientation, no failed expectation), with the Home tile tests and the sidebar test again.
- `testIPadLandscapeStartupShowsSavedHomeAndRestoresStories` fails on the iPad mini on this branch **and on `main`** (8115b24) with the same assertion: after tapping the feed it allows 2 seconds for `staticTexts["Loading stories"]` or the saved story, and on a loaded Mac the list is still showing its skeleton, whose label is "Loading stories in <feed>". By hand the stories appear about 2 seconds later. It predates this branch and is a test timing problem; not fixed here.
- Screenshots: run 10's iPhone 17 Pro and iPad Pro 11-inch screenshots were looked at (a handful of near-duplicates skipped), and the app was walked by hand on the iPad mini (portrait and landscape, system Dark: Home, All Feeds and back, Classic, Front Page, a story, Home from a story and back, Settings, Reading controls in Sepia and Dark Gray), on the iPad Pro 11-inch (Home, Classic, a story, rotation, Home from a story) and on the iPhone (Home, All Feeds, Classic). iPhone landscape, Front Page and the reader on iPhone were judged from run 10's screenshots only.

Fixed after looking (both caused by this branch's narrower columns):
- The split view's sidebar showed its title as "Pi…" beside its four toolbar buttons. The title is removed from that column's bar on regular width (`ReaderSidebarView`); iPhone keeps "Pigeon".
- List metadata truncated at both ends in a narrow column ("YouTube C… 3 months ago · 19 min vi…"). The reading time now keeps its width like the date, so only the name gives way (`ArticleRowView`).

Looks wrong, not changed (design calls):
- **Front Page in the iPad list column.** At 340pt (iPad Pro, and the mini in landscape) the grid is two columns of about 146pt: headlines run to four lines and "3 months ago · 19 min video" wraps. The 330pt threshold sits just under the column's ideal width; at the mini's 300pt portrait column the single column reads well. The bar also shows an inline "For…" title above the page's own "For You" masthead, and the search field under the bar is dimmed.
- **Home in iPad landscape.** The tiles are capped at 960pt and centred, but the dateline and the toolbar stay at the window's edges, so they no longer line up with the grid. With two folders the row is mostly empty; judge with a real library.
- **Status bar over Sepia.** With the system in Dark and the reader in Sepia, the clock side is fine but the Wi-Fi and battery icons over the reader column are white on cream.
- iPhone landscape reader shows only the story header above the fold (from run 10's screenshot; not compared with `main`).

Not verified:
- A CI run on the iPad mini that gets past the black screen (see above).
- The full UI suite.
- "Not fixed" items 1, 5, 6 and 7 below were not exercised on a simulator.
- Pre-existing, seen in the run: on an iPad in landscape the split view's sidebar stays in the accessibility tree under Home, so its rows duplicate the tiles' identifiers (and VoiceOver's elements).

Earlier runs (2, 5, 8) were picked up while the laptop was briefly awake and failed ten minutes later; the workflow now holds the Mac awake with `caffeinate` while it runs. It also created two simulators on the Mac, `iPad Pro 11-inch (M4) (Pigeon CI)` and `iPad mini (A17 Pro) (Pigeon CI)`, because the existing iPad simulators were booted.

### Measured (runs 9 and 10 agree within 6%; simulator on the Mac, Debug)
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

### UI, from the code review (items 2, 3, 4 and 8 since checked on an iPad mini simulator)
1. **Rotating or resizing across the compact/regular boundary rebuilds the reader.** `ReaderShellView` hosts the story in the detail column on regular width and in a separate stack on compact. The switch restarts every `.task`, so the open is recorded again, a story marked unread is marked read again (On Open), open sheets close and video restarts. Fix: record an explicit open once per selection in the model, and host the reader in one place.
2. **The reader's navigation bar may ignore the reader theme on iPad.** The theme's colour scheme is applied to content only (`ReaderThemeColorSchemePlacement.environmentOnly`), so Sepia under system Dark could show a light title on a cream page. Needs eyes on a device before choosing between `toolbarColorScheme` and a bar background. **Checked:** in Sepia under system Dark the title and the More button are dark on cream and legible, and Dark Gray is right. Only the system status bar icons over the reader column stay white.
3. **Returning to a feed on iPad reopens its remembered story** in the detail column without a tap, and that counts as an explicit open (`reconcileSelection`, `isReadingOpenArticle` is false on regular width). **Confirmed:** Home, then For You again, reopened the last story untouched and it had left the unread list. Going to a different view shows "Choose a story".
4. **Reading controls and the image viewer are iPhone sheets on iPad**: a centred form sheet over the text being adjusted, and a small card for a zoomable image. **Confirmed for Reading controls:** at its first height the sheet is translucent with the article showing through and offers only Typeface and Text size; Theme needs a drag up. It stays system-dark whatever the reader theme. The image viewer was not opened.
5. **Confirmation dialogs anchor to whole containers on iPad** (`ArticleBodyView.swift`, `ReaderSidebarView.swift`, settings screens), so the popover does not point at what was tapped.
6. **Trackpad scrolling cannot pull to the next or previous story** (`ReaderBoundarySwipeRecognizer` has no `allowedScrollTypesMask`). No hover effects anywhere.
7. **The undo banner still sits over the reader's bottom bar** for six seconds after Mark Read on iPhone. Only its width was changed.
8. Possible: article CSS mixes `prefers-color-scheme: dark` colours into a light reader theme on iPad (`StructuredHTMLJavaScript.swift`), if the web view does not inherit the environment-only scheme. **Checked:** the sample story's colours are right in Sepia under system Dark; real newsletter CSS was not tried.

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

The temporary `push` trigger and `.github/ios-device-layout.request`, which let this branch request runs before the file was on `main`, are removed. `workflow_dispatch` is the only entry point, so the next run is possible only after the merge: `gh workflow run ios-device-layout.yml --ref main -f devices="iPad mini"`.

## Handed off to the Mac
The work above was written in a Linux container; a local session on the Mac did the checks listed under "Checked locally" on 2026-11-18. No pull request has been opened.
