# Changelog

All notable changes to Pigeon are documented in this file.

## Unreleased

### Fixed

- Substack paid-only posts sent to a free subscriber with no preview at all (the email body is empty) now carry the Paywall label. Previously only teasers that stopped partway at Substack's paywall block were labeled.

## [0.1.9.0] - 2026-11-04

### Added

- YouTube transcripts on iPhone and iPad. Under the player of any YouTube video (saved or from a feed), Get Transcript fetches the captions and chapters from YouTube on the phone itself, shows them at once and stores them in Pigeon so other devices load them directly. The transcript follows the video: the playing line is highlighted and kept in view (it waits 4 seconds after you scroll it), tapping a line or chapter jumps the video there, and chapters appear as headings. If YouTube doesn't answer within 25 seconds or has no captions, a message and Try Again replace the spinner.
- Read It Later on iPhone and iPad. Long-press a link in an article and choose Read It Later (or tap it and pick Read It Later); a toast confirms and you stay in the article. The share sheet saves pages from Safari, Messages, YouTube and other apps straight to Read It Later, and offers Add as Feed first for feed and channel links. Saved pages are cleaned up in the background with Defuddle; opening one that isn't ready shows it preparing, and a page that can't be extracted after three tries offers Open Original and Try Again. Read It Later sits below Starred with an unread count, and filters Unread/Archive, Text/Video and length, sorted by saved time or length. Finishing a saved article archives it; videos play in the in-app player. Saves made offline are kept and sent when Pigeon reconnects. Saved items never appear in Today, Unread, folders or For You.
- Articles and videos longer than 10 minutes show their length ("12 min read", "1 hr 5 min video") on list rows, the Front Page and the article header, on iOS and web. Settings → Reading → Show reading time turns it off. Text length is estimated from the article; for a feed that sends only a teaser, opening it in reader mode records the full article's length. YouTube durations are fetched hourly. The Worker moves to schema v16.
- Newsletters that arrive as a paywalled teaser (Substack, beehiiv, and Ghost paid posts sent to a free subscriber) carry a Paywall label beside the title in the iOS list, Front Page, and article header, and in the web reader. Full copies sent to paying subscribers are not labeled.
- Read It Later in the web reader. Right-click a link inside an article and choose Read It Later (Shift+right-click keeps the browser's own menu); the article stays put and a toast confirms the save. The Read It Later section below Starred lists saved links with a thumbnail, title, source, length and when you saved them, with Unread/Archive, All/Text/Video and length filters and newest, oldest, shortest and longest sorts (remembered on this device). Opening a link saved without its text fetches and cleans the page, then stores it; if that fails, Open original and Try again are offered. Reaching the end of a saved article archives it. Archive, Remove, Open original and Copy link sit in the article toolbar, and YouTube links play in the built-in player. Saved items stay out of All, Today, folders, unread counts, notifications and feed settings.
- In the web reader, right-click a story in the list to mark everything above it (or below it) as read without opening it. It follows the list's current feed, search, filter and sort, includes stories not loaded yet, and offers Undo. With the keyboard, focus a story and press Shift+F10, then use the arrow keys and Enter.

### Changed

- iOS no longer saves to Readwise Reader: Share to Reader, the Readwise token setting and the stored token are gone, replaced by Read It Later. The sign-in session moves to the app group's keychain so the share extension can use it.
- In an Unread list (the Unread view, or a feed or folder filtered to Unread), a story you open or mark read stays in place, dimmed, instead of vanishing. The list re-filters when you refresh, switch feeds, change the filter or sort, or mark everything read; on iOS also after 15 minutes away. Same for stories marked unread under the Read filter. iOS and web.
- The web reader has a quieter design: three hairline-separated columns, icon toolbars instead of rows of word buttons, a short source-and-time line on each story, and a neutral graphite dark mode in place of the navy one. Dark mode follows the system until you pick one. Sort, filters, titles-only and bulk mark-read live in the list's ⋯ menu; More like this, Not interested, View and Readwise live in the article's ⋯ menu. The sidebar can be hidden, and narrow windows show one column at a time. Articles now match the app theme by default (Settings → Appearance and shortcuts → Article theme); before, the article stayed light in dark mode because Light was the only default. A Light article theme saved under that old default switches to Match app once. Settings → Reading → Appearance chooses System, Light or Dark for the app.
- The iPhone and iPad sidebar's folder arrow is smaller and lighter, so folder names lead the row.
- The web reader no longer has a Save to Readwise option; Read It Later replaces it. The Worker's Readwise endpoints stay for the iOS build on TestFlight.

### Fixed

- Offline sync no longer stalls on a run of long newsletters. The server caps each sync page by article size as well as count, because a page of long issues could exceed the Worker's CPU limit and fail every time, leaving an iPad on months-old cached stories. After a failed page shrinks its request, the app grows the page size back instead of finishing a full rebuild three changes at a time.
- A feed whose cached stories are left over from a failed sync says "Sync failed · updated …" instead of "Cached", and Settings → Offline Library shows the last sync error.

## [0.1.8.0] - 2026-10-26

### Added

- A newspaper-style Front Page home layout for iPhone: a masthead, a lead story with an image and summary, then a two-column headline grid. Classic stays the default; switch in the list's More → Display → Layout or in Settings → Reading → Layout.

### Changed

- Marking many stories read and undoing it match stories by identity, so large bulk actions finish faster.
- Opening a folder or feed is much faster. The app asks the server once for the page of story identifiers, reuses every story body it already has when the server confirms the body is unchanged, and downloads any new or changed bodies in a single request instead of five sequential ones. Read and starred state arrives with the identifiers, so an unchanged page needs one small round trip.
- The server answers story-content requests with one batched database round trip instead of four sequential queries, sends each body once to Pigeon's own apps, and uses index-only plans for Today, per-feed unread lists, and unread counts.
- The web app loads a first visit to a feed or folder with a single request, refreshes cached views without re-downloading unchanged bodies, and serves the app shell with cache validation headers.

### For contributors

- Database schema v15 adds `items.content_version` (bumped whenever a story body changes or is pruned) and replaces `idx_items_unread_feed` with a covering `(feed_key, received_at DESC)` unread index. Deploy the Worker so the migration runs before relying on the new iOS build.
- `stream/items/ids` item references now carry `timestampUsec`, `read`, `starred`, and `contentVersion`; `stream/items/contents` and `stream/contents` items carry `contentVersion` and omit `summary` when the request sends `X-Pigeon-Client`. Third-party Google Reader clients see the previous shapes.

## [0.1.7.0] - 2026-10-07

### Fixed

- Large cached folders, feeds, and Today open promptly while preserving pagination, saved article text, and unread counts.
- Searching saved stories stops processing article bodies when enough matches are found, and moving between stories stays responsive in filtered lists.
- Marking many stories read and undoing the action avoid repeated list updates while keeping reading position and saved changes consistent.
- Image-rich stories avoid repeated image discovery during scrolling, and list image permissions reset correctly when display settings change.

### For contributors

- Local Worker image processing uses the patched Sharp library that resolves the librsvg security advisory.

## [0.1.6.0] - 2026-10-05

### Changed

- For You shows every qualifying story scoring above 50, instead of filling a fixed list of 30.

### Fixed

- Recommendation pages stay complete and consistently ordered through read changes and service restarts; failed refreshes preserve the previous readable list.
- Sidebar counts survive refreshes and reopening the app, rejected stories stay removed, and saved article text remains available when the server has removed its copy.
- Resetting preferences clears older queued feedback while preserving newer feedback and unrelated reading actions.
- Topic matching recognizes dotted A.I. without matching email addresses and avoids severe slowdowns on long text and malformed markup.

### For contributors

- Reader image and cached-startup interface checks handle scrolling and already-completed loading reliably.
- Deployment documentation covers the recommendation helper's bounded persistent snapshots and deployment order.

## [0.1.5.0] - 2026-09-27

### Added

- The native Reader now exposes an Unread smart view with the global unread count, including existing saved view preferences.

## [Unreleased]

### Added

- Choose up to 20 monitored topics in Settings to prioritize matching For You stories across publishers, with a Recommended sort that preserves their ranking.
- New feed subscriptions immediately show up to three newest stories without importing the older backlog on later refreshes.
- Follow public YouTube channels by URL or look up handles such as `mkbhd` in Add Feed. Broader channel-name search is available when a YouTube API key is configured.
- Watch YouTube entries inside the iOS and browser readers, with playback controls, fullscreen, and an Open in YouTube fallback.

### Fixed

- Reader collection entry and lifecycle refreshes now revalidate cached articles automatically while retaining cached content during offline or failed refreshes. Shared article identities keep bodies and status updates consistent across lists, queued edits survive held responses, and warm synchronization preserves unrelated pagination and the open article.
- Daily database maintenance now advances through small indexed batches instead of rescanning the full article library every hour. Starred and unread views also use targeted indexes, preventing routine Pigeon traffic from exhausting the D1 daily read allowance.
- Sidebar folders can be renamed and deleted. The folder list updates immediately, and deleting the open folder no longer leaves a ghost collection.
- Feed notifications now treat a subscription's stream ID (`feed/7`) and feed slug as the same feed, so enabling a feed in Settings actually alerts after background refresh.
- Fresh Worker instances now honor the stored database schema version, reject unsupported newer versions safely, and use an atomic indexed one-time sync backfill, preventing repeated full-library scans from exhausting D1 reads.
- Offline library caches now detect incomplete syncs, rebuild automatically, and keep unread counts aligned with authoritative server navigation snapshots.

## [0.1.3.0] - 2026-08-23

### Fixed

- Reader mode now follows a feed across For You `feed_key` and stream `feed/{rowid}` identities, so choosing Reader View or Website in one list applies in the other.
- iPad Feed Content and Reader View now remount when the story or reading mode changes, so the next article no longer opens already scrolled.
- Searching no longer leaves a stale unread or unstarred row after you mark the story read or starred. The same update applies to library-wide hits that are not in the open list.

## [0.1.2.0] - 2026-08-20

### Fixed

 - The top error banner now clears when you switch feeds or leave a failed search, so a stale load or search failure no longer covers the next list.
 - Not Interested from Today or a feed now drops the story from an already-loaded For You list.
 - Mark Above / Below as Read during search follows the visible hit list instead of the unfiltered collection cache.
 - Mark All as Read during search now marks the visible hits, not every story in the open collection.
 - Mark Older Than during search now marks the visible hits, not every older story in the open collection.
 - Mark Above and Mark Below as Read now follow the visible Unread/Read/All list, so hidden unread stories stay unread when the Read filter is on.
- Searching a list now respects Unread, Read, and All, so a read story no longer appears while Unread is selected.
- After 60% Read marks a story again after you mark it unread. Scrolling a story that is already read no longer consumes that trigger.
- Mark All as Read now marks the visible Unread/Read/All list, not hidden unread neighbors behind the Read filter.
- Mark Older Than now marks the visible Unread/Read/All list, not hidden unread neighbors behind the Read filter.
- The Reading text-size slider now scales the article title and plain fallback body, not only HTML Feed Content / Reader View.
- Opening an article no longer jumps back to the feed list when a library refresh, unread membership update, or stale snapshot apply runs in the background.
- Freeing space from older read articles, or an incremental sync that prunes those bodies, no longer blanks the newsletter you are currently reading.
- Ordinary reading pans no longer count as back-to-feed; only the leading-edge swipe leaves the article.
- Swiping from the leading edge of an iPhone article returns to the feed again. The gesture is recognized on the reader itself, not only the back button.

## [0.1.1.0] - 2026-08-18

### Changed

- Large cached libraries now reuse each article while rebuilding folders and feeds at launch, making the first article list available much faster without changing its order or freshness.

## [0.1.0.0] - 2026-08-17

### Added

- iPad readers can move to the next or previous visible article with configurable hardware-keyboard shortcuts, using J and K by default.

### Fixed

- The iPad app no longer reports Offline for server-side failures while the device is connected, and successful refreshes clear stale connectivity state.
- Large folders, feeds, and Today load one bounded page at a time with an explicit Load More action instead of downloading the entire collection at once.
- Folder pagination is restored safely after relaunch, and an older page request can no longer overwrite a newer refresh.

## [0.0.2.0] - 2026-08-17

### Fixed

- Keep the article you are reading open when a refresh updates its server identifier.
- Keep iPhone and iPad library status accurate when the server is reachable, recover stale offline banners after a successful refresh, and preserve cached and queued reading when connectivity genuinely drops.

## [0.0.1.0] - 2026-08-16

### Fixed

- Newsletter feeds that use nested layout tables now display as a clean reading column, while genuine data tables retain readable borders and horizontal scrolling.
