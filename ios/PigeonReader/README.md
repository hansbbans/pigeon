# Pigeon

Pigeon is a focused native iPhone/iPad client for the existing Pigeon Worker. It uses the same Google Reader-compatible ClientLogin and edit-tag APIs as Reeder Classic and NetNewsWire, then adds a small authenticated API for recommendations and richer reading signals.

The sidebar includes For You, Unread, Starred, synchronized folders, and individual feeds. Use the add button to subscribe by URL. A feed's context menu supports renaming, moving to an existing or new folder, and unsubscribing; a folder's context menu supports renaming and deletion. These operations use Pigeon's existing Google Reader-compatible subscription endpoints, so the library remains shared with other reader apps. Because Google Reader labels do not retain empty folders, a new folder is created when its first feed is assigned.

Story rows support native leading/trailing swipes for read and star state, with the same actions in their context menus. In the reader, swipe horizontally or use the bottom controls to move to the previous or next story. Selecting a section or feed never opens its first story automatically.

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
