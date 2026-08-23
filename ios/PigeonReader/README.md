# Pigeon

Pigeon is a focused native iPhone/iPad client for the existing Pigeon Worker. It uses the same Google Reader-compatible ClientLogin and edit-tag APIs as Reeder Classic and NetNewsWire, then adds a small authenticated API for recommendations and richer reading signals.

The sidebar includes For You, Unread, Starred, synchronized folders, and individual feeds. Use the add button to subscribe by URL. A feed's context menu supports renaming, moving to an existing or new folder, and unsubscribing; a folder's context menu supports renaming and deletion. These operations use Pigeon's existing Google Reader-compatible subscription endpoints, so the library remains shared with other reader apps. Because Google Reader labels do not retain empty folders, a new folder is created when its first feed is assigned.

Story rows support native leading/trailing swipes for read and star state, with the same actions in their context menus. In the reader, a leading-edge swipe to the right returns to the feed list on iPhone. A fresh upward swipe that starts at the bottom opens the next article in the selected collection, and a fresh downward swipe that starts at the top opens the previous article. Navigation stops at the collection's ends, and ordinary scrolling does not navigate when it merely reaches a boundary. Website mode keeps normal page scrolling. Selecting a section or feed never opens its first story automatically. On iPad, an external keyboard can move to the next or previous visible article; J and K are the defaults, and both shortcuts are configurable in Settings.

Large folders, feeds, Today, and Starred show a bounded first page, then offer Load More for older articles instead of downloading the whole collection at once. For You stays a single recommendation page. Search stays scoped to saved articles, and server-side errors are surfaced as errors rather than treated as connectivity failures.

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
