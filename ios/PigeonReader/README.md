# Pigeon

Pigeon is a focused native iPhone/iPad client for the existing Pigeon Worker. It uses the same Google Reader-compatible ClientLogin and edit-tag APIs as Reeder Classic and NetNewsWire, then adds a small authenticated API for recommendations and richer reading signals.

The sidebar includes For You, Unread, Starred, synchronized folders, and individual feeds. Use the add button to subscribe by URL. A feed's context menu supports renaming, moving to an existing or new folder, and unsubscribing; a folder's context menu supports renaming and deletion. These operations use Pigeon's existing Google Reader-compatible subscription endpoints, so the library remains shared with other reader apps. Because Google Reader labels do not retain empty folders, a new folder is created when its first feed is assigned.

To follow a YouTube channel, use Add Feed and type a handle such as `mkbhd` or `@mkbhd`, select the matching channel, and tap Add. Broader channel-name search is available when the server has a YouTube API key configured. You can also paste a complete channel URL such as `https://www.youtube.com/@GoogleDevelopers` or its public Atom feed URL. Changing the search clears the previous selection, and folder assignment works the same as for ordinary feeds. Channel lookup requires the Worker version with `/feeds/youtube/search` support.

Video entries show YouTube's player above the description, with standard controls, fullscreen, and an Open in YouTube button. Playback starts on demand and stops when leaving the reader or backgrounding the app. Reader View preferences remain saved for ordinary articles. Playback requires an internet connection.

Story rows support native leading/trailing swipes for read and star state, with the same actions in their context menus. In the reader, a leading-edge swipe to the right returns to the feed list on iPhone. A fresh upward swipe that starts at the bottom opens the next article in the selected collection, and a fresh downward swipe that starts at the top opens the previous article. Navigation stops at the collection's ends, and ordinary scrolling does not navigate when it merely reaches a boundary. Website mode keeps normal page scrolling. Selecting a section or feed never opens its first story automatically. On iPad, an external keyboard can move to the next or previous visible article; J and K are the defaults, and both shortcuts are configurable in Settings.

Rows highlight on touch, and folder chevrons and child rows use coordinated, reversible motion. A folder stays anchored unless a small scroll is needed to reveal its first feed. In regular-width layouts, switching feeds crossfades only the article pane while the sidebar stays in place. Reduce Motion disables folder animation and shortens the pane fade. Manual read and star changes update smoothly. Successful Readwise saves show a brief confirmation without interrupting reading; failures still show an alert. Motion respects the system Reduce Motion setting.

Pulling at an article boundary previews the adjacent story and gives one light haptic when it is ready to open. Reversing or releasing before the threshold cancels. Previous story and Next story are also available in the reader's More menu. The reading-controls button opens a sheet for text size, line spacing, theme, and reset; it can expand for larger text. Native back navigation and each article's saved reading position are preserved.

Cached stories remain visible while a feed refreshes. A feed without a cached page opens with a static placeholder and its destination title immediately; the placeholder reuses the story-row layout for the selected density, including thumbnail space and Dynamic Type. The progress indicator appears only if loading lasts longer than 200 milliseconds. A failed first load offers Retry without briefly reporting an empty feed. A short opacity transition replaces the placeholder with stories. Reopening a feed restores its saved row and partial-row offset before revealing the list.

Opening a folder can quietly prepare the first screen of nearby feeds. This work stops when navigation, account, filter, or article state changes, and failures do not interrupt reading. Background updates keep saving while the visible sidebar and timeline wait for scrolling or navigation to settle. New or reordered stories that would shift existing rows wait behind a New stories or Updated stories button; older-page appends resume automatically. Folder symbols, unread counts, and feed icons use restrained transitions with fixed icon space and Reduce Motion support.

Image Rich timelines prepare image selection and decode small thumbnails away from the UI thread. Folder preparation and visible rows share a bounded cache scoped to the account and story content. Speculative image work is limited to the first screen and only runs when normal remote-image loading is enabled. Loading placeholders never request images.

Long-press a feed to preview up to three cached headlines and choose Open Feed without marking anything read. Folder collapse preserves the tapped header as far as the native scroll bounds allow. Explicit filter, sort, and density changes keep a surviving visible story in place and use a short transition. Offline notices and errors float above the content without moving the navigation bar or reading position.

Large folders, feeds, and Today automatically load older stories as the last few visible rows approach. Automatic paging stops after an error, a repeated continuation, or three pages without further scrolling; Load More remains available for explicit retries and heavily filtered lists. Search shows progress as soon as a query is entered, including the brief typing delay. Earlier results stay visible while a new query runs in the same collection and scope; changing accounts, feeds, or scope hides those results. A failed search preserves previous results and offers Retry.

Article content is prepared off the main thread, and the next already-downloaded story is prepared while reading. Prepared bodies and extracted Reader View content share a small in-memory cache that invalidates when the source content changes. Paragraph anchors preserve the reading position through image loading and typography changes, with recent anchors retained during the session and saved reading depth as a fallback.

Returning from a story restores the feed's visible row and its offset. Rotation and window-width changes preserve the same story and partial-row offset after the rows reflow, within the native scroll limits. Positions are kept separately for each account, collection, filter, sort, and search during the current session. If that row disappears, restoration uses a nearby surviving story.

Manual read and star actions offer a six-second Undo banner in both the list and reader. Undo restores the prior state through the same durable offline queue, including when a filter has hidden the affected story. Automatic read tracking does not create banners. VoiceOver announces Undo and keeps it available until dismissed or superseded; newer actions and account changes invalidate old banners.

The image viewer supports double-tap focal zoom, pinch zoom, native panning, and a Close button. Zoom in and Reset zoom provide alternatives to gestures, including VoiceOver adjustment actions. Downward sheet dismissal is available at the fitted size and disabled while zoomed in. Large images are prepared asynchronously at a bounded resolution, and a small memory cache avoids repeated downloads while revisiting images.

Large folders, feeds, Today, and Starred show a bounded first page, then offer Load More for older articles instead of downloading the whole collection at once. For You stays a single recommendation page. Library search stays scoped to saved articles; YouTube channel lookup lives in Add Feed, and server-side errors are surfaced as errors rather than treated as connectivity failures.

Story titles and article text use the bundled Bookerly reading faces with Dynamic Type scaling. Navigation, controls, source names, dates, and other interface metadata continue to use Apple's system font for native clarity.

## Generate and run

From this directory:

```bash
xcodegen generate
xcodebuild -project PigeonReader.xcodeproj \
  -scheme PigeonReader \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  CODE_SIGNING_ALLOWED=NO build
```

To run the unit tests on a concrete simulator, use the available iPhone 17 simulator UDID from `xcrun simctl list devices available`:

```bash
xcodebuild test -project PigeonReader.xcodeproj \
  -scheme PigeonReader \
  -destination 'platform=iOS Simulator,id=SIMULATOR_UDID' \
  CODE_SIGNING_ALLOWED=NO
```

On first launch, enter the HTTPS base URL for Pigeon and the existing API password. The app refuses unencrypted HTTP connections before sending credentials. The password is used only for ClientLogin; the resulting token and normalized base URL are stored in Keychain. No production credential belongs in this repository.

TestFlight releases are manual and run on Pigeon's dedicated self-hosted Mac runner. See `../../docs/testflight-release.md` for the Apple resources, GitHub secrets, and release procedure.


## Motion performance checks

Run `python3 scripts/benchmark-sidebar.py` from this directory to compare the previous sidebar projection with the current single-pass implementation. It compiles optimized Swift, verifies identical snapshots, alternates measurement order, and reports median CPU time after warmup. These are host measurements, not iOS frame-rate results.

The `PigeonMotionPerformanceUITests` suite records CPU, memory, elapsed time, and rendering hitches for large-folder toggles, repeated cached feed navigation, and sidebar scrolling. Its deterministic Debug fixture contains 100 folders, 3,000 feeds, and 80 stories in each exercised feed. Compare runs on the same device, OS, build configuration, and accessibility settings. `PigeonNavigationMotionUITests` also covers cancelled back navigation, feed previews, and error-banner position stability. Simulator/device execution requires a working licensed Xcode installation; compiler checks alone do not validate visual smoothness.
