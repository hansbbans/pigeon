# Save to Pigeon (browser extension)

Saves pages and links to Pigeon's **Read It Later** from Chrome, Dia and Vivaldi (all Chromium, Manifest V3).

- **Toolbar button** or **Alt+Shift+S**: saves the current page. Defuddle runs on the live tab, so logged-in and paywalled pages you can see are saved as clean text with their images. The badge shows ✓ when it's saved.
- **Right-click a page > Save page to Pigeon**: the same.
- **Right-click a link > Save link to Pigeon**: saves the link only. Pigeon marks it pending, and the iOS or web app extracts it later.
- **YouTube watch pages** are saved as videos: title, channel, thumbnail and duration, without article text and without fetching the transcript.

If the extraction fails (a restricted page, a page with no article, a timeout), the bare link is saved instead. If Pigeon can't be reached or the sign-in has expired, the save waits in the extension's storage and is sent later: after the next successful save, on browser start, or while you browse (at most once a minute). The badge shows how many saves are waiting.

The extension needs the save API from PR #161 (`POST /api/v1/saved`) on the Pigeon server. Against a server without it, saves wait in the queue.

## Build

```bash
cd extension
npm ci
npm run build      # dist/chromium/, loadable unpacked
npm run check      # tests, typecheck, build, audit (what CI runs)
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
- `contextMenus`, `storage`.
- Host permission for `https://pigeon.hanscho.com` only. Requests to Pigeon go from the background service worker, so the Worker needs no CORS. Signing in to a different address asks for that one origin at runtime (`optional_host_permissions`); plain http is only accepted for `localhost` and `127.0.0.1`, for a local `wrangler dev`.

## Layout

- `src/core/`: browser-free logic (address handling, ClientLogin, the save request and its size rules, the retry queue, the save flow, sign-in). Tested with `node --test` against a mocked API.
- `src/page/`: the extraction that runs in the tab (`extract.ts`, tested under jsdom with the real Defuddle) and its bundle entry (`inject.ts`, built to `extract.js`).
- `src/background/`: the service worker that connects browser events to `src/core`.
- `src/options/` and `static/`: the settings page and icons.
- `src/browser-api.ts`: the only import of the WebExtension API, through `webextension-polyfill`.
- `manifests/<browser>.json` and `scripts/build.mjs`: one manifest per browser, built to `dist/<browser>/`. Only `chromium` exists today. A Safari or Firefox build adds a manifest and an entry in `BROWSERS` in the build script; the code stays shared.

## Size limits

Pigeon stores at most 900 KB of article HTML plus text per item and rejects requests over 2 MB. The extension keeps the beginning of a very long article, cut at an element boundary, with a note that the rest is on the original page. If a request is still too large, or Pigeon rejects the content, the save is retried as a bare link, so a save never fails because of its size.

## Licenses

Defuddle 0.19.6 (MIT, Steph Ango) is bundled into `extract.js`, and webextension-polyfill (MPL-2.0, Mozilla) into the other scripts. See `THIRD_PARTY_NOTICES.md`, which the build copies into `dist/`.
