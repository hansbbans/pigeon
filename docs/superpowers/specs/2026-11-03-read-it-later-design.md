# Read It Later: design

Date: 2026-11-03. Status: draft for Hans's approval.

## Intent

Hans reads newsletters in Pigeon and regularly hits links he wants to read later. Today the only option is "Share to Reader", which sends the link to Readwise Reader, a separate app. He wants Pigeon to be his read-later app: save a link from inside an article or from anywhere else, then read it later in Pigeon as clean full text, or watch it in Pigeon if it's a YouTube video. **This replaces Readwise.**

The second aim is the cleanest possible reading experience. kepano's open-source tools (Defuddle and Obsidian Web Clipper, both MIT) set the bar, and we borrow from them directly.

## Goals

1. **Save from inside Pigeon.** Long-press a link (iOS) or right-click it (web), choose **Read It Later**, and stay in the current article. A brief toast confirms the save.
2. **Save from outside Pigeon.**
   - The iOS share sheet: Safari, Messages, the YouTube app, anything that shares a URL.
   - A browser extension for Chrome, Dia and Vivaldi (all Chromium).
3. **A "Read It Later" section in the sidebar** (web and iOS), with a count.
   - Filters: Unread / Archive; All / Text / Video; length (any, under 5 min, 5–15 min, 15+ min).
   - Sort: newest saved, oldest saved, shortest, longest.
   - Mockup reviewed in the brainstorm: a list with a thumbnail, a serif title, the source, the length, and how long ago it was saved.
4. **Clean full text.** Opening a saved article shows the cleaned article in Pigeon's own reader. YouTube links play in Pigeon's existing in-app player.
5. **Archive.** Finishing a saved item moves it to Archive, where it can still be opened.
6. **Reading length on every article in Pigeon,** not only saved ones. It can be turned on and off in settings. Text shows "12 min read"; video shows its own duration ("18 min video").
7. **Defuddle replaces Readability everywhere** Pigeon turns a web page into clean text: reader mode on web and iOS, snippet-only RSS items, and saved links.
8. **YouTube transcript on request.** A "Get transcript" button under the player fetches the transcript and chapters, stores them on the item, and shows them synced to the video. The current line is highlighted, the transcript auto-scrolls, and tapping a line seeks the video.
9. **Remove Readwise** (UI, client code, Worker endpoints, token storage) once Pigeon's own saving works.

## Non-goals (this version)

- Emailing links to a save@ address. Hans said he will never use it.
- Importing his existing Readwise library. Pigeon's list starts empty.
- Highlights, notes, and tags on saved items.
- A Safari extension on the Mac. This is a later phase.
- Offline image caching. Images stay as remote URLs.
- Running Defuddle on newsletter email HTML. Newsletters arrive as finished HTML and are shown as-is. Defuddle targets web pages and could strip real newsletter content.
- The hosted defuddle.md API. No third-party dependency.

## Anti-goals (failure even if it technically works)

- **Leaving the article to save a link.** A save must not navigate away, open a browser, or lose the reading position.
- **A Mail look.** No sender/subject/preview inbox rows, no unread dots as the organizing idea, no swipe-to-triage as the main interaction (repo design rule). The saved list leans editorial: thumbnail, serif title, quiet metadata.
- **Losing a save.** A save made from the share sheet or extension must land even if extraction fails. The link is stored first and cleaned later.
- **Extracting on the Worker.** The Worker is on the Free plan with 10 ms CPU per request. Measured Defuddle cost is 13–40 ms for typical articles and 400–500 ms for heavy pages, so all extraction runs on the client (browser, iOS app, extension).
- **Breaking the TestFlight build.** The API must stay backward compatible with the build currently on TestFlight.

## Constraints and existing pieces

All paths are relative to the repo root.

- **Worker CPU.** 10 ms per HTTP request (`wrangler.toml`, `docs/` and the `worker-free-plan-cpu` memory). Responses that return bodies are bounded by bytes (`SYNC_PAGE_BODY_BUDGET` in `src/sync-api.ts`).
- **D1 row size.** Capped at 1 MB; use `MAX_CONTENT_SIZE = 900_000` and the helpers in `src/content-size.ts`.
- **Schema.** `src/migrations.ts`, currently `REQUIRED_SCHEMA_VERSION='15'`; `04-storage/SCHEMA.sql` must mirror it. A bump is one-way (an older Worker throws on a newer schema), so the bump ships in a normal deploy, never a hotfix.
- **Items.** The `items` table requires `feed_key`. There is no concept of an item that doesn't come from a feed. Read and star live in `items.is_read` / `is_starred`, mirrored into `item_statuses` by triggers.
- **Item writers.** They must avoid no-op updates (sync compaction). Never delete `sync_changes` rows.
- **Retention.** The cron in `src/cron-handler.ts` prunes the content of read, unstarred items. Saved items must be exempt.
- **Existing extraction.**
  - Web: vendored Readability in `src/browser-readability.ts`, driven by `prepareReadingFrame` in `src/browser-app.ts`. Pages come from the Worker proxy `GET /api/v1/browser/reader-source` (`src/browser-reading-api.ts`; it is SSRF-checked, with 5 MB / 15 s caps).
  - iOS: `Core/ReaderViewExtractor.swift` runs `Resources/Readability.js` in an offscreen WKWebView over a URLSession fetch.
- **Existing YouTube player.** `ios/.../Features/Reader/YouTubePlayerView.swift` and `Core/YouTubeVideo.swift`; on web, `renderYouTubePlayer` in `src/browser-app.ts` plus helpers in `src/browser-app-client.ts`. Both trigger from `item.original_url`, so a saved YouTube item with `original_url` set plays without new player code.
- **Existing iOS link handling.**
  - `Features/Reader/StructuredHTMLView.swift`: WKWebView with `allowsLinkPreview = false`; JS posts `link` events.
  - `Features/Reader/ArticleBodyView.swift` `handleLink`: a tap opens "Open in Browser" / "Share to Reader".
- **Existing iOS share extension.** `PigeonShareExtension`: it only hands a URL to the app for adding a feed (`PendingFeedStore`, `pigeon://add`). The extension cannot read the API session today: `KeychainSessionStore` has no access group. The app group `group.com.hans.pigeon.reader` exists.
- **Auth.** One shared password, and `POST /accounts/ClientLogin` returns a fixed token. API calls send `Authorization: GoogleLogin auth=pigeon/<token>` (`src/api-auth.ts`). `/api/v1/*` has no CORS.
- **Web article frame.** A sandboxed `srcdoc` iframe with `allow-same-origin`. Its links open in new tabs, and there is no link context menu. The only existing context menu is on list rows (`openArticleContextMenu`).
- **Workflow.** The build order is API, then web, then iOS. Web-only PRs don't touch the shared Mac. Batch `.github` changes.

## Decisions

### Defuddle (kepano/defuddle, MIT)

- Use Defuddle's single-file browser bundle (`dist/index.js`, about 92 KB gzipped).
  - Web: vendor it in place of `src/browser-readability.ts`.
  - iOS: ship it as `Resources/Defuddle.js` in place of `Readability.js`.
  - Pin a version (0.19.6 or later, which includes the Markdown XSS fix; we only use HTML output). Keep the MIT notice.
- Use the HTML output, plus the metadata Defuddle returns: `title`, `author`, `published`, `site`, `image`, `favicon`, `wordCount`, `schemaOrgData`.
- Normalize `published` to ISO 8601 UTC, or drop it. Defuddle passes through strings like "An hour ago".
- Keep Readability as a fallback for this release, used when Defuddle throws or returns empty content. Remove the fallback in a later cleanup once Defuddle has proven itself. *(Claude's call.)*
- Defuddle reads the page's mobile CSS and hidden elements, which only works with a real rendered DOM. That works in iOS's offscreen WKWebView. On web, the current code parses into an inert `<template>`, so we lose that step unless parsing happens in a hidden sandboxed iframe. Builder: measure whether the iframe is worth it. The extension always has the live page, so it gets the full benefit.

### Where saved items live

- **One system feed** holds every saved item: `source_type = 'saved'`, a fixed `feed_key` (for example `pigeon:saved`), display name "Read It Later". Create it in the v16 migration.
  - This reuses everything items already get: sync, read state, the YouTube player keyed off `original_url`, and the Google Reader API.
  - Saved items do **not** appear in Today / All articles / folders. They appear only in Read It Later. *(Claude's call: Hans described a separate section.)*
  - **Older clients** (the TestFlight build current at deploy time, and third-party Google Reader clients) see the saved feed as an ordinary feed called "Read It Later". Its items show up in their Today and All views. This is acceptable as a transitional state: Hans is the only user, and step 3 ships the Worker and a new TestFlight build together. No capability flag and no sync cursor change. *(Claude's call.)*
- **Archive = `is_read = 1`.** Unread / Archive are the read filter on that feed.
  - An item is archived when Hans reaches the end of the article (the existing read-on-scroll-to-end behaviour) or marks it read.
  - Un-archiving is marking it unread.
  - *(Claude's call on what counts as "finished".)*
- **Retention exemption.** The cron never prunes content from the saved feed, read or not.
- **Dedupe by URL.**
  - Normalize the URL: drop the fragment and common tracking parameters (`utm_*`, `fbclid`, `gclid`, `si` on YouTube, and so on). For YouTube, normalize to the canonical watch URL from the video ID.
  - `message_id = 'saved:' + sha256(normalized URL)`, inserted with `INSERT OR IGNORE`.
  - Re-saving an existing URL marks it unread and bumps its saved time, so it returns to the top. *(Claude's call.)*
- **Saved time** is `received_at`, which drives "newest/oldest saved".
- **Title before extraction.** Until extraction finishes, the title is the shared page title if the sender supplied one, otherwise the URL's host and path.

### Schema v16 (additive)

New nullable columns on `items`, so every article can carry length and the metadata the saved list shows:

- `word_count INTEGER`
- `media_kind TEXT` (`'text'` or `'video'`)
- `duration_seconds INTEGER` (video)
- `author TEXT`, `published_at TEXT` (ISO 8601 UTC), `image_url TEXT`, `site_name TEXT`
- `extraction_state TEXT`, used for saved items: `'pending'` when stored as a bare link, `'done'`, or `'failed'`

Plus a separate table for transcripts, which can be large and are fetched only on request:

- `item_transcripts(item_id PRIMARY KEY, language, html, text, created_at)`, with a foreign key to `items` and the same size cap rules.

The builder may adjust names. The constraints are: additive only, mirrored in `SCHEMA.sql`, and no rewrite of existing rows in a single request. Backfill runs in bounded batches from the cron.

### Reading length for all articles

- Reading speed is 238 words per minute, rounded up to whole minutes with a minimum of 1. *(Claude's call.)*
- Video shows its duration instead.
- **Where `word_count` comes from:**
  - Saved items and Defuddle-extracted RSS items: Defuddle's `wordCount`.
  - Email and RSS ingest: a cheap count over `text_content` (or stripped HTML), bounded so it stays inside the CPU budget.
  - Existing items: a cron backfill in small batches. Until it reaches them, the client hides length (no placeholder).
- **RSS items that only carry a snippet.** The ingest count would measure only the snippet. When a client extracts such an article in reader mode, it reports Defuddle's word count through a small mutation (for example `set_word_count`). The mutation writes only when the value changes, to avoid no-op updates; last writer wins. It sends only the count, not the content. *(Claude's call.)*
- **YouTube items from feeds.** The cron backfill fetches their duration in batches using the existing `YOUTUBE_API_KEY`.
- Sync and list APIs return `word_count`, `media_kind` and `duration_seconds` as new optional fields. Older clients ignore them.
- **Setting:** "Show reading time", on web and iOS, default **on**. It only hides or shows the label. The length filters and sorts in Read It Later still work when it's off. *(Claude's call on the default.)*

### Save API (Worker)

- `POST /api/v1/saved` with `{ url, title?, content? }`, where `content` is optional extracted output: `{ html, wordCount, author, published, image, site, mediaKind, durationSeconds }`.
- Behaviour:
  - Validates and normalizes the URL, upserts the saved item, and returns the item id and state.
  - **With `content`**, stores it (capped at `MAX_CONTENT_SIZE`) and marks `extraction_state = 'done'`.
  - **Without `content`**, stores a pending bare link.
  - Must stay cheap: no fetching, no parsing.
- A companion call lets a client upload extraction for a pending item: `PUT /api/v1/saved/:id/content` with the same `content` shape. It also covers re-extraction.
- `POST /api/v1/saved/:id/transcript` stores a transcript.
- Archive, unarchive and delete use the existing read mutation. For delete, the builder decides whether to add `DELETE /api/v1/saved/:id` or a mutation. Delete is in scope: a "Remove" action on saved items. *(Claude's call: a read-later list needs delete.)*
- Mutations follow `src/mutation-api.ts` conventions: receipts, idempotency, and staying under D1 query caps.

### Who extracts, and when

- **Browser extension:** runs Defuddle on the live tab and posts `content` with the save. This is the best quality path: images are loaded, and logged-in or paywalled pages the reader can see come through intact.
- **iOS, saving from inside Pigeon:**
  1. POST the bare link immediately.
  2. Extract in the background with Defuddle (URLSession fetch, offscreen WKWebView).
  3. Upload the content.
- **iOS share extension:** POSTs the bare link only, so the extension stays fast and inside its memory limit. The app extracts pending items the next time it is active.
- **Pending items on any client:**
  - The iOS app sweeps pending saved items after sync and extracts them.
  - The web app extracts a pending item when Hans opens it, using the existing `reader-source` proxy and Defuddle, then uploads the result.
  - A pending item that's opened before extraction finishes shows a loading state, then the content.
- **Failure:** after a failed extraction, the item stays openable. It shows the original page in website mode (SFSafariViewController on iOS, a new tab on web), offers "Try again", and is marked `'failed'` after 3 attempts.
- **YouTube saves:** skip text extraction. Store `media_kind = 'video'`, the title, channel, thumbnail and description, and `duration_seconds` from schema.org `duration` (ISO 8601 duration parsed to seconds). Defuddle's YouTube extractor supplies these without fetching the transcript; use `parse()`, not `parseAsync()`.

### In-article saving

- **iOS:**
  - **Long-press a link** shows a context menu: **Read It Later** first, then Open in Browser, Copy Link, Share…. Implement with WKWebView's link context-menu delegate; this needs `allowsLinkPreview` handling, so the builder confirms the approach on device.
  - **Tapping a link** keeps today's dialog, with "Share to Reader" replaced by "Read It Later".
  - A save shows a toast ("Saved to Read It Later") and never navigates.
- **Web:**
  - **Right-clicking a link** inside the article frame shows a Pigeon menu: Read It Later, Open in New Tab, Copy Link.
  - Shift + right-click still gives the browser's own menu. *(Claude's call.)*
  - The menu reuses the styling of the existing list-row context menu.
  - A save shows a toast.

### iOS share extension

- Extend `PigeonShareExtension` with a **Read It Later** action. The current "add feed" handling stays.
- If both make sense, the extension shows a small choice sheet: Read It Later (default) or Add as Feed. *(Claude's call: the builder may decide on a cleaner UX, such as defaulting to Read It Later and showing Add as Feed only when the URL looks like a feed.)*
- The extension needs the API session. Move the session token to a shared keychain access group (or the app group), with a migration that runs on the app's first launch after the update.
- **Offline:** if the POST fails, queue the save in the app group, show "Saved, will sync". The app flushes the queue on launch and on sync.

### Browser extension (Chrome, Dia, Vivaldi)

- **Location:** a new `extension/` directory in this repo. Manifest V3, TypeScript, Defuddle bundled. Model the build on Obsidian Web Clipper: per-browser manifests and `webextension-polyfill`, so a Safari build can be added later without restructuring.
- **Ways to save:**
  - The toolbar button: saves the current page and shows a confirmation.
  - The right-click page menu: "Save page to Pigeon".
  - The right-click link menu: "Save link to Pigeon". This sends only the link (pending), because the page isn't loaded.
  - A keyboard shortcut.
- **Settings page:** Pigeon URL and password. It runs ClientLogin once and stores the token in `chrome.storage`.
- **Requests:** go from the extension's background service worker, with host permission for the Pigeon origin, so no CORS change is needed on the Worker.
- **Permissions:** `activeTab`, `scripting`, `contextMenus`, `storage`, and host permission for the Pigeon origin only. No `<all_urls>`: content runs on demand through `activeTab`.
- **Distribution:** unpacked or Chrome Web Store. The builder decides; unpacked is fine for v1.
- **CI:** builds and tests the extension. It is Node-only, so keep it off the iOS path filter.

### Read It Later section

- Sidebar entry "Read It Later", showing the unread count. It sits below Starred on web and in the iOS section list.
- The list shows a thumbnail (`image_url`, or the video thumbnail; no image means no thumbnail block), a serif title, the source (site or channel), the length, and the relative saved time.
- **Filters** (as in the mockup):
  - Unread / Archive.
  - All / Text / Video.
  - Length bucket: Any, under 5 min, 5–15 min, 15+ min.
  - Items with unknown length appear only under "Any".
- **Sort:** newest saved (default), oldest saved, shortest, longest. Unknown length sorts last.
- Filter and sort choices persist per device.
- **Item actions:** Archive / Unarchive, Remove, Open original, Copy link.

### Reader polish borrowed from Web Clipper (ideas, our own code)

These apply to Defuddle-extracted content in Pigeon's reader on web and iOS:
- Footnotes open as popovers in place. Defuddle standardizes them to `#fnref:N` / `#footnotes`.
- Code blocks: keep Defuddle's language markup; add a copy button.
- Title, author, date and site block at the top.

Stretch, only if cheap: an outline from headings, and an image lightbox (web already has image zoom).

Typography and theme settings are **out** of this project; Pigeon's existing reader styling stays.

### YouTube transcript on request

- A **"Get transcript"** button below the player, on YouTube items (saved or from feeds). The result is stored in `item_transcripts` and syncs to every client.
- **Fetching:**
  - **iOS (primary):** run Defuddle's YouTube extractor with `parseAsync()` in the offscreen WKWebView. Pass a custom `fetch` that bridges to Swift URLSession, so the requests come from the phone, not a datacenter, and aren't blocked by CORS.
  - **Web:** best effort through the Worker. Add a narrowly scoped proxy that allows only `youtube.com` / `*.youtube.com` hosts and bounds bytes and time. YouTube may block Cloudflare IPs; on failure, say "Couldn't get the transcript here, try from the iPhone app".
  - **Extension:** when saving a YouTube page from the live tab, the extension can include the transcript if it's cheap (the page is already loaded). Optional.
- **Display:** port the logic of Web Clipper's `src/utils/reader-transcript.ts` (MIT; keep the notice) for both web and the iOS player's WKWebView.
  - Highlight the active segment, auto-scroll (pauses while the user scrolls), tap a segment to seek.
  - Chapters appear as headings.
  - Our iframe players already exist; add `enablejsapi=1` and the time-update listener.
- **Risk:** this depends on YouTube's unofficial InnerTube API, whose client versions are hard-coded in Defuddle and broke in early 2026. Keep Defuddle easy to bump. The failure state must be clean, never a spinner forever.

### Readwise removal

- Remove "Share to Reader" and the Readwise buttons on iOS and web.
- Remove the Readwise token storage on iOS (keychain) and the Worker endpoints: `/api/v1/browser/readwise/save`, `/api/v1/readwise/token`, and the `_meta` token backup.
- Delete the stored token data.
- This happens in the same release that ships in-article saving, so there is never a build with neither.

## Delivery order

Each step is its own PR (or a few) and ships on its own:

1. **Defuddle everywhere.** Swap web and iOS reader extraction, keeping the Readability fallback. Add metadata capture.
2. **Schema v16 and reading length.** Columns, ingest word counts, cron backfill, sync fields, the setting, and labels on web and iOS.
3. **Read It Later core.** Saved feed, save API, retention exemption, in-article saving (iOS long-press, web right-click), pending-item extraction, the Read It Later section with filters and sort, archive and remove, the iOS share extension, and Readwise removal.
4. **Browser extension** for Chrome, Dia and Vivaldi.
5. **YouTube transcript on request.**
6. **Later:** Safari Web Extension on macOS (and iOS Safari, which the same container would cover).

## Verification expectations

- **Worker:**
  - Unit tests for URL normalization and dedupe, save/upsert/re-save, the retention exemption, size caps, word counting, the backfill batch bound, and the v16 migration from v15.
  - API contract fixtures for the new fields.
- **Extraction:**
  - Fixture pages (a blog post, a footnote-heavy essay, a code-heavy post, a Substack post, a YouTube watch page) compared against Readability's output. Include an empty-result fallback test.
- **iOS:**
  - Unit tests for the pending sweep, the offline share queue, and keychain migration.
  - UI tests for long-press save, the Read It Later list (filters, sort, archive), and the transcript UI.
  - Add the core save path to `.github/ios-smoke-ui-tests.txt`.
- **Web:** tests for right-click save, the Read It Later filters and sort, and pending extraction on open.
- **Extension:** tests for the save flow against a mocked API, and the login and settings page.
- **Manual on device:**
  - Share from Safari, Messages and the YouTube app.
  - Save 5+ links rapidly.
  - Save offline, then come online.
  - Save the same URL twice.

## Left to the builder

- Exact column, endpoint, and type names.
- Toast and menu visuals within the existing web and iOS styles.
- The share-extension choice UX between saving and adding a feed.
- Whether web extraction uses a hidden iframe for Defuddle's mobile-CSS step.
- Thumbnail sizing and caching on iOS.
- Extension distribution (unpacked vs Web Store) and build tool.
- Which Web Clipper reader niceties beyond footnotes and code copy fit cheaply.
