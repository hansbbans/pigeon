# Read It Later step 5: YouTube transcripts (Worker API and web)

Spec: `docs/superpowers/specs/2026-11-03-read-it-later-design.md`, "YouTube transcript on request".
This PR ships the Worker API and the web client. The iOS client is a later PR.

## Transcript document (format version 1)

```json
{
  "version": 1,
  "language": "en",
  "segments": [
    { "start": 4, "duration": 2, "text": "This is a 3." },
    { "start": 6, "text": "It's sloppily written." }
  ],
  "chapters": [{ "start": 0, "title": "Introduction" }]
}
```

- `version`: always `1`. A reader skips a version it does not know.
- `language`: optional BCP 47 code of the caption track.
- `segments`: 1 to 20 000 entries, sorted by `start`. `start` and the optional `duration` are seconds (number, 0 to 604 800, stored rounded to milliseconds). `text` is plain text (whitespace collapsed, at most 5 000 characters); blank segments are dropped.
- `chapters`: optional, at most 500, sorted by `start`; `title` is plain text (at most 300 bytes). Omitted when empty.
- Unknown keys are dropped. The stored canonical JSON is at most 450 000 bytes; a request body at most 1 000 000 bytes.

Defuddle's YouTube extractor groups captions into readable paragraphs; its transcript text (`variables.transcript`) is `### Chapter` lines and `**M:SS** · text` lines. A client turns it into this document: one segment per `**M:SS**` line (whole seconds), `duration` = next start minus this start (none for the last), and each chapter starts at the segment after its heading. `parseDefuddleTranscript` in `src/browser-transcript.ts` is the reference.

Storage: `item_transcripts.html` holds the canonical JSON (the column name predates the format), `text` holds chapter titles and segment text, one per line, for search; `language` and `created_at` (time of the last change).

## Endpoints

Authenticated like every `/api/v1` route (`Authorization: GoogleLogin auth=pigeon/<token>`). `:id` is the item UUID or any Google Reader item id (`tag:google.com,2005:reader/item/<16 hex>`, hex, or decimal), URL-encoded.

### `PUT /api/v1/items/:id/transcript` (POST is the same)

Body: the transcript document. Works for any item whose `media_kind` is `video` or whose `original_url` is a YouTube video, saved or from a feed.

`200`:

```json
{ "itemId": "<uuid>", "updated": true, "language": "en", "segmentCount": 3, "chapterCount": 2, "bytes": 356 }
```

`updated` is `false` when the stored document is already identical: nothing is written and no sync event is added. A different document replaces the stored one.

Errors (`{ "error": string, "code": string }`): `400 invalid_transcript`, `404 item_not_found`, `413 transcript_too_large`, `422 not_a_video`, `503 transcript_unavailable`.

### `GET /api/v1/items/:id/transcript`

`200`: `{ "itemId": "<uuid>", "updatedAt": "<ISO 8601 UTC>", "transcript": { ...document } }`. `404` with `code` `item_not_found` or `transcript_not_found`. The body is bounded by the 450 KB storage cap and is spliced from the stored JSON without parsing.

### Sync signal

- `GET /api/v1/sync` article payloads and GReader `stream/items/contents` / `stream/contents` items carry `"hasTranscript": true` when a transcript exists. The key is absent otherwise (never `false`), so older clients and fixtures see nothing new.
- A transcript store that changes the document adds one `article` upsert event for the item in the same D1 batch, so other clients receive the article again with `hasTranscript: true` and then GET the body. YouTube items carry small bodies. A repeat identical upload adds no event. `content_version` is not changed.
- Clients that want to stay current without sync can GET on open; the web client GETs when `hasTranscript` is set, and again before fetching when the reader taps "Get transcript".

### `GET|POST /api/v1/browser/youtube-proxy?url=<URL>` (web only)

Best-effort fetch path for the web client, which cannot call YouTube directly (no CORS). Only `https://youtube.com` or `https://*.youtube.com` on the default port, no credentials, and only these paths and methods: `POST /youtubei/v1/player`, `POST /youtubei/v1/next` (JSON body at most 16 KB), `GET /api/timedtext`. Redirects are not followed. Caller credentials and cookies are never forwarded; `X-Pigeon-Upstream-User-Agent` (a `Mozilla/5.0` or YouTube app agent) and `X-Pigeon-Upstream-Language` become the upstream `User-Agent` and `Accept-Language`. One 10-second deadline; the response body (at most 4 MB, JSON or XML) passes through unparsed as a `200`. Upstream non-2xx is `502 youtube_unavailable` with `upstreamStatus`; network failure or timeout is `502 youtube_unreachable`. YouTube may refuse Cloudflare's addresses, so the web shows "Couldn't get the transcript here, try from the iPhone app" on any failure.

## Web client

- `src/browser-transcript.ts` (served as `window.PigeonTranscript`): Defuddle runs `parseAsync()` on an empty document for the watch URL with a custom `fetch` routed through the proxy; the whole fetch is capped at 25 seconds. The view (adapted from Obsidian Web Clipper's `reader-transcript.ts`, MIT) highlights the playing segment, auto-scrolls it into the transcript box unless the reader scrolled in the last 4 seconds, seeks on a click, and shows chapters as headings.
- The embed URL gains `enablejsapi=1` and `origin`; the view sends `listening` and `getCurrentTime` to the iframe and reads `infoDelivery` messages, accepting only `https://www.youtube.com` from the player frame. No external script.

## iOS follow-up

- Fetch on the phone with Defuddle's YouTube extractor (`parseAsync()` in the offscreen WKWebView, `fetch` bridged to URLSession), convert with the rules above, `PUT` the document, and show it under `YouTubePlayerView`.
- Read `hasTranscript` from sync; GET the body on open.
- Name the four transcript fixtures in `APIContractTests.swift` and remove them from `AWAITING_IOS_CONTRACT_TESTS` in `test/api-contract.test.ts`.
