# Read It Later step 3: Worker core (saved feed, save API, removal)

**Spec:** `docs/superpowers/specs/2026-11-03-read-it-later-design.md` ("Where saved items live", "Save API (Worker)", "Constraints", "Readwise removal").

**Scope of this PR:** Worker only (`src/`, `test/`, `docs/`). No schema change: schema v16 (step 2) already has every column this needs. Web and iOS follow in their own PRs (see "Follow-ups" at the end), in the order API, web, iOS.

This document is the contract. Web and iOS builders should not need to read the server code.

## Decisions

- **One system feed.** `feed_key = 'pigeon:saved'`, `source_type = 'saved'`, display name "Read It Later". It is created lazily on the first save (an upsert inside the save batch), not in a migration, so builds that never save see no new feed. A save also reactivates the feed if an older client unsubscribed from it (the update is conditional, so a normal save adds no feed sync event).
- **Archive = `is_read = 1`.** The existing read mutation (`set_read`, `set_read_batch`) and GReader `edit-tag` work on saved items unchanged. Unarchive is marking unread.
- **Removal is a hard delete**, through a new mutation kind `remove_saved`. The existing `trg_sync_article_delete` trigger appends an article `delete` event, which sync already delivers and the iOS app (TestFlight build included) already applies. Nothing deletes `sync_changes` rows.
- **No extraction on the Worker.** The save and upload endpoints validate, cap and store; they never fetch or parse a page.
- **Exclusion from Today / All / folders** is server-side where the server builds the list (`/api/v1/browser/articles`, recommendations) and client-side where the client builds it from sync (iOS). Older clients see the saved feed as an ordinary feed (accepted in the spec).
- **Readwise stays.** The Worker Readwise endpoints (`/api/v1/browser/readwise/save`, `/api/v1/readwise/token`, the `_meta` token backup) are untouched: the current TestFlight build uses them. They are removed in a later PR, after a TestFlight build without Readwise has shipped.

## Identifying saved items

- **Feed:** `feedKey == "pigeon:saved"`, or `sourceType == "saved"`.
  - Sync feed payloads now carry `sourceType` on every feed: `"email"`, `"rss"` or `"saved"`.
  - GReader `subscription/list` entries carry `sourceType` too.
- **Article:** `feedKey == "pigeon:saved"` in sync payloads. In GReader items, `origin.streamId` is the saved feed's `feed/<rowid>` (look the rowid up in `subscription/list` by `sourceType == "saved"`).
- `extractionState` is present only on saved items, so it also identifies them, but key on the feed.

## Endpoints

All three are authenticated exactly like the other native routes: `Authorization: GoogleLogin auth=pigeon/<token>`. A missing or wrong token gets `401`. JSON in, JSON out. No CORS (extension and app requests do not need it).

### `POST /api/v1/saved`: save a link

Request:

```json
{
  "url": "https://example.com/essays/slow-software?utm_source=pigeon#comments",
  "title": "Slow software",
  "content": { "html": "<article>…</article>", "wordCount": 2650, "author": "Ada Lovelace",
               "published": "2026-10-28T09:30:00+01:00", "image": "https://example.com/slow.jpg",
               "site": "Example Essays", "mediaKind": "text", "durationSeconds": null, "title": "…" }
}
```

- `url` (required): http or https, at most 2048 characters, no credentials.
- `title` (optional): the shared page title. Used as the item title until an extraction supplies one.
- `content` (optional): an extraction (shape below). With it, the item is stored complete; without it, it is a pending bare link.

URL normalization (this is the dedupe key):

- Lower-cased host, default port dropped, fragment dropped.
- Removed query parameters: every `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref_src`, `igshid` (case-insensitive, matched on the decoded key); on YouTube hosts also `si` and `feature`.
- The remaining pairs keep their original text and order (`q=b%20c`, `path=/x`, a bare `flag` stay as sent), so a URL normalizes the same with or without tracking parameters. Empty pairs (`&&`, a trailing `&`) are dropped.
- YouTube video links (`youtube.com/watch?v=`, `m.youtube.com`, `youtu.be/ID`, `/shorts/ID`, `/embed/ID`, `/live/ID`) become `https://www.youtube.com/watch?v=ID` and the item is a video (`mediaKind: "video"`). Other parameters such as `t` are dropped.
- `message_id = "saved:" + sha256_hex(normalized URL)`; the item id is a UUID derived from it, so the same URL always maps to the same `id`.

Behaviour:

| Case | Status | Effect |
| --- | --- | --- |
| New URL | `201` | Item created in `pigeon:saved`, unread, `receivedAt` = now. Title: `content.title`, else `title`, else host + path (`example.com/essays/slow-software`). |
| Same URL again | `200` | Marked unread and `receivedAt` = now (back to the top). With `content`, the extraction is applied as in `PUT …/content`. Without it, a `failed` item goes back to `pending` (clients retry), and a `pending` item takes the new `title`. Only changed columns are written. |

Response:

```json
{ "id": "abde2a43-22dc-8734-9049-5cd424e03007",
  "readerId": "tag:google.com,2005:reader/item/0000000000000005",
  "url": "https://example.com/essays/slow-software",
  "state": "pending",
  "created": true }
```

- `id` is the sync API article id (`changes[].entityId`, `payload.id`). `readerId` is the long GReader id, the same as `payload.readerId`. Mutations accept either.
- `state`: `"pending"`, `"done"` or `"failed"` after the request.
- `contentTooLarge: true` appears only when the uploaded `html` exceeded the cap (below).

### `PUT /api/v1/saved/:id/content`: upload an extraction or report failure

`:id` is the item `id` (UUID) or its reader id (long form URL-encoded, 16-hex, or decimal rowid). Only items in the saved feed are accepted.

Upload body: the content object itself (same shape as `POST`'s `content`).

```json
{ "html": "<article>…</article>", "title": "Slow software, and why it lasts", "wordCount": 2650,
  "author": "Ada Lovelace", "published": "2026-10-28T09:30:00+01:00",
  "image": "https://example.com/images/slow.jpg", "site": "Example Essays", "mediaKind": "text",
  "text": "Software that waits for you." }
```

Failure body: exactly `{ "failed": true }`. It sets `failed` unless the item is already `done` (a failure never downgrades a finished extraction). Clients send it after their last retry (the spec says 3 attempts).

Response:

```json
{ "id": "…", "readerId": "…", "url": "https://example.com/essays/slow-software", "state": "done", "updated": true }
```

- `updated` is false when nothing changed (an identical re-upload): no write, no sync event.
- `contentTooLarge: true` as for `POST`.

### Content object

| Field | Type | Stored as | Rule |
| --- | --- | --- | --- |
| `html` | string | `html_content` | Required unless the item is a video. Capped at 900 000 UTF-8 bytes (`MAX_SAVED_HTML_BYTES`, the same budget as email and RSS). Over the cap: not stored, `contentTooLarge: true`, and the item stays `pending` (or keeps its earlier body and `done` state). |
| `text` | string | `text_content` | Optional plain text of the extraction (Defuddle's text output, or the article element's `textContent`). Clients should send it: `browser/articles` search (`q`) matches titles, authors, feed names and this text, never HTML. Truncated so that `html` plus `text` stay within 900 000 bytes. An upload that stores new `html` without `text` clears the old text. |
| `title` | string | `subject` | Whitespace collapsed, at most 1 000 bytes. |
| `wordCount` | number | `word_count` | 0 to 2 000 000, rounded. Otherwise dropped. |
| `author` | string | `author` | At most 500 bytes. Sync and GReader return it as `author`. |
| `published` | string | `published_at` | Only date-shaped values (`YYYY-MM-DD`, optionally with time and offset); stored as ISO 8601 UTC. A time without an offset is read as UTC. "An hour ago", future dates (more than 2 days ahead) and years before 1900 are dropped. |
| `image` | string | `image_url` | http(s) URL, else dropped. |
| `site` | string | `site_name` | At most 500 bytes. |
| `mediaKind` | `"text"` or `"video"` | `media_kind` | A YouTube URL is always `"video"`. |
| `durationSeconds` | number | `duration_seconds` | 0 to 1 000 000, rounded. Saved videos without one are also filled by the existing cron duration backfill. |

Wrong types for `content`, `html` or a string field are `400`. Unusable metadata values are dropped silently, because extractors pass them through. A field that is absent leaves the stored value alone.

After a successful upload, `extraction_state = 'done'` and `text_content` holds the uploaded `text` (or null). `content_version` goes up by one only when a stored field other than the saved time and read flag actually changes, so GReader clients refetch only real edits; a re-save with identical content just moves the item up.

### Errors

| Status | When |
| --- | --- |
| `400` `{ "error": "…" }` | Invalid JSON, a body that is not an object, a bad `url`, wrong field types, text content without `html`, `{ "failed": false }`, `failed` combined with content. |
| `401` | Missing or wrong token. |
| `404` `{ "error": "Saved item not found" }` | `PUT` for an unknown id or an item outside the saved feed. |
| `405` | Wrong method (`POST /api/v1/saved`, `PUT …/content` only). |
| `413` | Request body over 2 000 000 bytes, counted as it streams in (chunked bodies without `Content-Length` included). |
| `503` | Database unavailable or migration failed. Retry. |

### Removal: the `remove_saved` mutation

Sent through the existing `POST /api/v1/mutations`, so it gets receipts, idempotency and the offline queue for free.

```json
{ "mutations": [ { "id": "<uuid>", "kind": "remove_saved", "itemIds": ["<id or readerId>", "…"] } ] }
```

- `itemIds` must not be empty; it counts toward the 200-item batch limit.
- `itemIds` must be item ids (the UUID `id`), **not** reader ids. A reader id is a rowid, and SQLite reuses the rowid of a deleted newest row, so a retried removal by reader id could delete a different item. Any reader id in the list makes the whole request `400` (`must be item ids, not reader ids`).
- Every listed item that still exists must be in the saved feed, otherwise the mutation is `failed` with `Item … is not a saved item` and nothing is deleted.
- Items that no longer exist are skipped, so a retry under a new mutation id is `applied`. A replay of the same id is `already_applied`.
- Effect: the item row is deleted; its `item_statuses` and `item_transcripts` rows cascade; its `engagement_events` are deleted (they reference the row without a cascade, and a removed save should not keep shaping recommendations).

How it reaches clients: the delete trigger appends `('article', <id>, 'delete')` to `sync_changes`. The next sync page carries

```json
{ "entityType": "article", "entityId": "<id>", "operation": "delete", "payload": null }
```

Earlier events for that item are compacted behind it. Saving the same URL again later recreates the item with the same `id` (an `article` upsert, then a `status` upsert). GReader clients simply stop seeing the item in id lists.

Known limit: `items` has no `AUTOINCREMENT`, so if the removed item held the highest rowid, the next item inserted by any writer reuses that rowid, and therefore that GReader reader id. Pigeon clients key on `id` and apply the delete first, so they are unaffected, and `remove_saved` refuses reader ids for the same reason. A third-party GReader client that had already fetched the removed save under that reader id could show the old item in place of the new one. The window is a save followed by its removal before any other item arrives. A fix needs a table rebuild or an insert trigger, so it is left for a later schema change (see Follow-ups).

## Sync payload fields (`GET /api/v1/sync`)

All new fields are optional and omitted when null, so the TestFlight build ignores them.

Feed payload:

- `sourceType`: `"email"`, `"rss"` or `"saved"` (new, on every feed).

Article payload, in addition to the step 2 fields (`wordCount`, `mediaKind`, `durationSeconds`):

- `extractionState`: `"pending"`, `"done"` or `"failed"` (saved items only).
- `publishedAt`: ISO 8601 UTC, the page's own publication date.
- `imageURL`: lead image, for the list thumbnail.
- `siteName`: the site or channel, for the list's source line.
- `author`: existing field; for saved items it is the extracted byline.
- `receivedAt`: existing field; for saved items it is the saved time (newest/oldest saved sort).
- `html`: `""` while pending. `isRead` is the archive flag.

GReader `stream/items/contents` items gain the same optional fields, named in that API's style: `extractionState`, `publishedAt`, `imageUrl`, `siteName` (plus `wordCount`, `mediaKind`, `durationSeconds` from step 2). `author` carries the extracted byline.

## Where saved items do and do not appear

| Surface | Saved items | How |
| --- | --- | --- |
| `GET /api/v1/browser/articles` with `stream=all`/`reading-list`, `read`, `starred`, `user/-/label/…`, plus `since`/`before` (Today) | Excluded | Server-side filter `source_type <> 'saved'`. |
| `GET /api/v1/browser/articles?stream=saved` (new) | Only saved items | Works with `filter=unread|read`, `sort=newest|oldest|shortest|longest` (length sorts put unknown lengths last), `kind=all|text|video`, `length=any|short|medium|long` (under 5, 5 to 15, 15+ rounded-up minutes; unknown matches only `any`), `q`, `limit`, `continuation`. Lengths come from `word_count` at 238 wpm, or `duration_seconds` for video. |
| `GET /api/v1/browser/articles?stream=feed/<saved rowid>` | Only saved items | Same as `stream=saved`. |
| Recommendations (For You, unread, starred) | Excluded | Server-side. Reading a saved item still records the usual `read` engagement event, which can inform the topic profile; saved items are never candidates. |
| Sync (`/api/v1/sync`) | Included | New clients exclude them from Today / All / folders **client-side** using `feedKey`/`sourceType`. |
| GReader API (`subscription/list`, `unread-count`, `stream/*`) | Included, as an ordinary feed called "Read It Later", unless the request opts out with `xs=saved` | For older clients and third-party readers (spec). Pigeon extension `xs=saved` (query string or form body) on `stream/items/ids` and `stream/contents` leaves the saved feed out of the reading-list, read, starred and label streams (its own `feed/<id>` stream is unaffected); on `unread-count` it leaves saved items out of the reading-list total and keeps the saved feed's own `feed/<id>` entry. The web app sends it on streams and subtracts the saved feed from the `unread-count` total itself. |
| Web push | Never notifies | A subscription request that includes `pigeon:saved` succeeds for its other feeds; the saved key is dropped and never stored. Dispatch skips the saved feed too. The web notification picker should hide it (see Web PR). |
| Retention cron | Never pruned | The saved feed never enters the daily retention rotation. |
| RSS refresh, stale feeds, `/app/status` | Never | The refresh scheduler only selects `source_type = 'rss'`; stale feeds skip `saved`; `/app/status` leaves the saved feed out of the active feed count and saved items out of the unread count and newest-article time (its total and starred counts still include them). |
| `/feeds`, `/feeds/opml`, public Atom `/feed/<key>` | Never | The reading list has a fixed, guessable key, so its Atom feed is a `404`. |

Transitional behaviour for older clients (accepted by the spec): the TestFlight iOS build and GReader clients show saved items in Today/All, and their "mark all as read" in those views archives them.

## Implementation notes

- `src/saved-items.ts`: constants, URL normalization, content validation, the two handlers, the feed upsert, and the payload helper.
- `src/native-api.ts`, `src/index.ts`: routes `/api/v1/saved` and `/api/v1/saved/*`.
- `src/mutation-api.ts`: `remove_saved` (one lookup, then one batch: receipt, engagement delete, item delete).
- `src/sync-api.ts`, `src/greader.ts`: `sourceType` and the saved metadata fields. `src/article-author.ts`: `author` falls back to `items.author`.
- Exclusions all use `notSavedFeedSql()` from `src/saved-items.ts`: `src/browser-library-api.ts`, `src/recommendations.ts`, `src/cron-handler.ts` (retention), `src/stale-feeds-api.ts`, `src/web-push.ts`, `src/status.ts`, `src/index.ts` (`/feeds`, OPML, Atom).
- Reader ids come from one helper, `googleReaderItemId` in `src/item-identity.ts` (sync, GReader, recommendations, saves).
- Every write is a single conditional `UPDATE … WHERE (col IS NOT ? OR …)`, so repeats add no sync events. A save or re-save is two D1 round trips (a lookup, then one batch); a save that loses an insert race to a concurrent save of the same URL takes two more and is answered as a re-save.
- Tests: `test/saved-items.test.ts` (normalization, dedupe, save/re-save, upload, size cap, failure state, YouTube, validation, archive, removal through sync, retention exemption, no RSS refresh, exclusions). Contract fixtures: `saved-create.*`, `saved-content.*`, `saved-remove.request.json`, `sync-saved.response.json`; existing sync and subscription-list fixtures gained only `sourceType`.

## Follow-ups

### Web PR

- **The default All view and the unread badges must drop saved items.** All + Newest does not use `browser/articles` today (`usesBrowserArticlesQuery()` is false there): it reads GReader `stream/contents` and `unread-count`, and both include the saved feed. Either filter `origin.streamId` / the saved feed's entry out client-side, or route All through `browser/articles` (which already excludes saved items).
- Hide the saved feed in the web notification picker. The server ignores it in a subscription request, but listing it is misleading.

- Read It Later sidebar entry under Starred, with an unread count (`stream=saved&filter=unread`, or the saved feed's entry in `unread-count`). Exclude the saved feed from the Today/All counts built from `unread-count`, and hide it from the feed list (`sourceType == "saved"` in `subscription/list`).
- List: `stream=saved` ids, bodies and metadata through `stream/items/contents` (`imageUrl`, `siteName`, `wordCount`, `mediaKind`, `durationSeconds`, `extractionState`).
- Filters and sorts: Unread/Archive map to `filter`. Text/Video, length buckets, and shortest/longest are client-side over the loaded saved list. If saved lists grow past a few hundred items, add server-side `kind`, length and `sort=shortest|longest` to `stream=saved`.
- Right-click "Read It Later" in the article frame: `POST /api/v1/saved` with `{ url }`, then a toast.
- Pending items: extract on open (reader-source proxy plus Defuddle), then `PUT …/content` with `html` **and** `text`; after 3 failures send `{ "failed": true }`. Treat `contentTooLarge` as a failure.
- Remove: `remove_saved` through the existing mutation path (offline queue included), with the item `id` (`payload.id` / the save response `id`), never the reader id. Archive is the existing read toggle.
- Remove the web Readwise button in the same release that ships right-click saving.

### iOS PR

- Decode `sourceType` (feed) and `extractionState`, `publishedAt`, `imageURL`, `siteName` (article), all optional.
- Exclude `pigeon:saved` items from Today, All and folders; show them in the Read It Later section. Hide the saved feed from the feed list.
- Name the new fixtures in `APIContractTests.swift` and empty `AWAITING_IOS_CONTRACT_TESTS` in `test/api-contract.test.ts`; add a `remove_saved` encoder test against `saved-remove.request.json`.
- Save flows (long-press, share extension, offline queue) call `POST /api/v1/saved`; the pending sweep uses `PUT …/content` (send `html` and `text`) and `{ "failed": true }` after 3 attempts.
- Removal: queue `remove_saved` with the item `id` (UUID), never the reader id; apply the sync `delete` as today.
- Remove "Share to Reader" and the Readwise keychain token.

### Worker, later

- Remove the Readwise endpoints and the `_meta` token backup after a TestFlight build without Readwise ships.
- Rowid reuse after deleting the newest item (see "Known limit"): fix in the next schema change if third-party GReader clients matter.
- `POST /api/v1/saved/:id/transcript` (step 5).
