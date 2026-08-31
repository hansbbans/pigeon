# Changelog

All notable changes to Pigeon are documented in this file.

## [0.1.3.0] - 2026-08-23

### Fixed

- Reader mode now follows a feed across For You `feed_key` and stream `feed/{rowid}` identities, so choosing Reader View or Website in one list applies in the other.
- iPad Feed Content and Reader View now remount when the story or reading mode changes, so the next article no longer opens already scrolled.

## [0.1.2.0] - 2026-08-20

### Fixed

- The top error banner now clears when you switch feeds or leave a failed search, so a stale load or search failure no longer covers the next list.
- Not Interested from Today or a feed now drops the story from an already-loaded For You list.
- Searching a list now respects Unread, Read, and All, so a read story no longer appears while Unread is selected.
- Opening an article no longer jumps back to the feed list when a library refresh, unread membership update, or stale snapshot apply runs in the background.
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
