# Changelog

All notable changes to Pigeon are documented in this file.

## [0.1.0.0] - 2026-08-17

### Added

- iPad readers can move to the next or previous visible article with configurable hardware-keyboard shortcuts, using J and K by default.

### Fixed

- The iPad app no longer reports Offline for server-side failures while the device is connected, and successful refreshes clear stale connectivity state.
- Large folders, feeds, and Today load one bounded page at a time with an explicit Load More action instead of downloading the entire collection at once.
- Folder pagination is restored safely after relaunch, and an older page request can no longer overwrite a newer refresh.

## [0.0.1.0] - 2026-08-16

### Fixed

- Newsletter feeds that use nested layout tables now display as a clean reading column, while genuine data tables retain readable borders and horizontal scrolling.
