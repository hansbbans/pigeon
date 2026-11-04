# Save to Pigeon (browser extension)

Saves pages and links to Pigeon's **Read It Later** from Chrome, Dia and Vivaldi (all Chromium, Manifest V3), and from Safari on the Mac (the same code in a Safari Web Extension; see [Safari](#safari)).

- **Toolbar button** or **Alt+Shift+S**: saves the current page. Defuddle runs on a copy of the page as the tab shows it, so logged-in and paywalled pages you can see are saved as clean text with their images. The badge shows ✓ when it's saved.
- **Right-click a page > Save page to Pigeon**: the same.
- **Right-click a link > Save link to Pigeon**: saves the link only. Pigeon marks it pending, and the iOS or web app extracts it later.
- **YouTube watch pages** are saved as videos: title, channel, thumbnail and duration, without article text and without fetching the transcript.

If the extraction fails (a restricted page, a page with no article, a timeout), the bare link is saved instead. Every save is written to the extension's storage before it is sent and removed once Pigeon answers. So if Pigeon can't be reached, the sign-in has expired, or the browser stops the extension mid-request, the save waits and is sent later. It goes out after the next successful save, after signing in, on browser start, or on a timer (`chrome.alarms`) that backs off from 1 to 30 minutes while Pigeon stays unreachable. A save that keeps timing out or getting a server error with its full article is cut to its bare link after two tries, and a stuck save never holds back the ones behind it. A later bare-link save of the same URL keeps a queued extraction. The badge shows how many saves are waiting.

The extension needs the save API from PR #161 (`POST /api/v1/saved`) on the Pigeon server. Against a server without it, saves wait in the queue.

## Build

```bash
cd extension
npm ci
npm run build         # dist/chromium/ (loadable unpacked) and dist/safari/
npm run build:safari  # dist/safari/ plus the Safari app, dist/safari-app/ (macOS, Xcode)
npm run check         # tests, typecheck, build, audit (what CI runs)
```

`node scripts/build.mjs --watch` rebuilds on change.

## Load it unpacked

Build first, then load `extension/dist/chromium`:

- **Chrome**: open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, choose `extension/dist/chromium`.
- **Dia**: open the extensions page (`chrome://extensions` in the address bar), turn on **Developer mode**, click **Load unpacked**, choose `extension/dist/chromium`.
- **Vivaldi**: open `vivaldi:extensions`, turn on **Developer mode**, click **Load unpacked**, choose `extension/dist/chromium`.

After a rebuild, click the reload arrow on the extension's card.

Then pin **Save to Pigeon** to the toolbar. The settings page opens after installing and whenever a save needs a sign-in; you can also reach it from the extension's **Details > Extension options**. Enter the Pigeon address (default `https://pigeon.hanscho.com`) and the password, then **Sign in**. The password is sent once to `/accounts/ClientLogin`; only the returned token is stored (`chrome.storage.local`). **Sign out** forgets the token.

To change the shortcut, open `chrome://extensions/shortcuts` (Vivaldi: `vivaldi:extensions/shortcuts`; Vivaldi's own keyboard settings can also take over the shortcut).

## Permissions

- `activeTab` and `scripting`: read the current tab only when you save it. There is no content script and no `<all_urls>`.
- `contextMenus`, `storage`, and `alarms` (retrying waiting saves).
- Host permission for `https://pigeon.hanscho.com` only (Safari asks the user for it; see [Safari](#safari)). Requests to Pigeon go from the background service worker, so the Worker needs no CORS. Signing in to a different address asks for that one origin at runtime (`optional_host_permissions`); plain http is only accepted for `localhost` and `127.0.0.1`, for a local `wrangler dev`.

Defuddle gets a copy of the page (`document.cloneNode`), so the page you are reading is never changed. A detached copy has no computed styles, so Defuddle's mobile-CSS and hidden-element steps fall back to its markup rules.

## Layout

- `src/core/`: browser-free logic (address handling, ClientLogin, the save request and its size rules, the retry queue and its alarm, the save flow, sign-in, the badge). Tested with `node --test` against a mocked API.
- Shared with the Worker and bundled straight from `../src`: YouTube video ids and durations (`src/youtube.ts`) and UTF-8 truncation (`src/content-size.ts`).
- `src/page/`: the extraction that runs in the tab (`extract.ts`, tested under jsdom with the real Defuddle) and its bundle entry (`inject.ts`, built to `extract.js`).
- `src/background/`: the service worker that connects browser events to `src/core`.
- `src/options/` and `static/`: the settings page and icons.
- `src/browser-api.ts`: the only import of the WebExtension API, through `webextension-polyfill`.
- `manifests/<browser>.json` and `scripts/build.mjs`: one manifest per browser (`chromium`, `safari`), built to `dist/<browser>/`. `test/manifest.test.ts` keeps them in step: they may differ only in the keys Safari handles differently. A Firefox build would add a manifest and an entry in `BROWSERS`; the code stays shared.
- `safari/`: the Safari container app (xcodegen `project.yml`, a one-window SwiftUI app, the `.appex` stub and entitlements). `scripts/build-safari.sh` generates the Xcode project (not committed) and copies `dist/safari` into the `.appex`.

## Safari

Safari loads web extensions only from inside a Mac app, so `safari/` holds a small container app, **Save to Pigeon** (`com.hans.pigeon.safari`), whose extension (`com.hans.pigeon.safari.extension`) carries `dist/safari`. It needs Xcode and `brew install xcodegen`; CI does not build it.

```bash
cd extension
npm ci
npm run build:safari             # → dist/safari-app/Save to Pigeon.app
npm run build:safari -- --open   # the same, then launch it
```

The build is ad-hoc signed ("Sign to Run Locally"), not with a developer certificate, so Safari loads it only as an unsigned extension:

1. Safari > Settings > Advanced: turn on **Show features for web developers**.
2. Develop menu > **Allow Unsigned Extensions** (asks for your password). Safari turns this off every time it quits, so do it again after restarting Safari.
3. Run `dist/safari-app/Save to Pigeon.app` once. It registers the extension, shows whether it is on, and its button opens Safari's settings.
4. Safari > Settings > Extensions: tick **Save to Pigeon**. Its settings page opens; sign in as above. Safari asks whether the extension may access `pigeon.hanscho.com`: choose **Always Allow on This Website**.

After a rebuild, run the app again; Safari picks up the new build (the build number is the UTC build time, `YYYYMMDDHHMM`). If Safari shows two copies, an older build from another checkout is still registered: delete it, or run `lsregister -u` on its path.

What differs in Safari:

- **Site access.** Safari does not grant the manifest's host permission at install; the user allows each site, possibly only for a day. Without it, a request to Pigeon fails like a network error, so when a save fails that way the extension checks `permissions.contains` for the Pigeon origin (it always tries the request first: Safari may not report access granted in its own UI). Without access the save waits in the queue and retries every minute, the badge says so, and the settings page shows **Allow access** (which calls `permissions.request`). Once allowed, waiting saves go out. The same path covers a Chrome user who withheld site access. Signing in also requests the origin first, as on Chromium.
- **Reading the page.** The toolbar button grants `activeTab`; Safari may also ask once to allow the extension on that site. If Safari refuses, the bare link is saved, as on any restricted page.
- **Shortcut.** Option-Shift-S (`Alt+Shift+S` in the manifest). Safari has no settings page for extension shortcuts; if another extension holds the keys, use the toolbar button or the context menu.
- **Badge colours** are ignored by Safari (it always draws the badge in its own colour); the text and tooltip still show the state.
- **Minimum Safari 17** (`browser_specific_settings.safari.strict_min_version`): `scripting.executeScript` returns results from then on. Context menus are guarded, so the same code runs where Safari has none (iOS).

### Signed builds (not set up)

Unsigned extensions only work with the Develop setting above. To ship without it:

- **Developer ID (outside the App Store):** set `DEVELOPMENT_TEAM` and `CODE_SIGN_STYLE: Automatic` (or a Developer ID Application identity) for both targets in `safari/project.yml`, keep the hardened runtime and sandbox, `xcodebuild archive`, export with a Developer ID method, notarize with `xcrun notarytool submit --wait`, and staple with `xcrun stapler staple`. Keep the credentials in the Keychain (`notarytool store-credentials`), never in the repo.
- **App Store / TestFlight for Mac:** register `com.hans.pigeon.safari` and `com.hans.pigeon.safari.extension` in App Store Connect, add an app icon asset catalog (the app has none today), archive with automatic signing, and upload.
- **iOS and iPadOS Safari:** the web extension code is ready (no context menus is handled), but it needs an iOS app target and an iOS Safari extension target in `safari/project.yml`, larger icons, and an Apple Developer team to install on a device.

## Size limits

Pigeon stores at most 900 KB of article HTML plus text per item and rejects requests over 2 MB. The extension keeps the beginning of a very long article, cut at an element boundary, with a note that the rest is on the original page. If a request is still too large, or Pigeon rejects the content, the save is retried as a bare link, so a save never fails because of its size.

## Licenses

Defuddle 0.19.6 (MIT, Steph Ango) is bundled into `extract.js`, and webextension-polyfill (MPL-2.0, Mozilla) into the other scripts. See `THIRD_PARTY_NOTICES.md`, which the build copies into `dist/`.
