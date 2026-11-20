# Unread-first offline rebuild (iOS)

Date: 2026-11-20. Status: approach A chosen by Hans; open questions answered; doc pending approval.

## Why

On 2026-11-20 Hans's iPhone (TestFlight 4401) showed folder A three days stale, and pull-to-refresh spun forever. Cause, verified against production:

1. An interrupted incremental sync marked the offline cache `.syncing`, which `OfflineCacheIntegrity.requiresFullRebuild` treats as broken. (Fixed on `main` by 7aa474fb, not yet on TestFlight.)
2. A full rebuild replays the whole `sync_changes` log from cursor 0 in 50-event pages: 18,324 compacted events, 2,331 requests, about 350 MB of bodies. At 0.15–0.4 s a page that is more than 10 minutes of foreground time.
3. The rebuild is all-or-nothing. `beginFullRebuild` deletes the previous staging generation, so every interruption (app backgrounded, network blip) restarts from zero. The phone was seen restarting at cursor ~1,000 of 80,124.
4. Pull-to-refresh awaits `prepareOfflineLibrary(force: true)`, which awaits the rebuild. Hence the endless spinner.

Most of what the rebuild downloads is thrown away: right after a sync the app prunes bodies of all but the newest 500 read articles.

## What Hans wants

The phone is for reading **unread** articles. That set must be fast, complete and reliable. Starred and Read It Later stay on the phone. Search over older or read articles is nice to have, not a priority. He does not need the whole library on the phone.

Production shape on 2026-11-20: 2,734 unread (about 120 MB of bodies, oldest from February), 4,679 read older than 3 days (about 160 MB), 5 starred, 1 saved.

## Goals

- A rebuild makes folders, unread counts and article lists correct within seconds, without waiting for bodies.
- Bodies for unread articles download in the background, newest first. An interrupted download resumes where it stopped.
- Pull-to-refresh and the Refresh command finish in seconds regardless of any rebuild or body download running.
- Opening an unread article whose body has not arrived yet fetches it on the spot.
- Routine sync problems are repaired in place. A full rebuild is reserved for real breakage.

## Non-goals

- Server-side search, or search over articles that are not on the phone (later, separately).
- Changing the incremental sync protocol (`/api/v1/sync`). It stays the catch-up path after a rebuild.
- The web app and the browser extension.

## Anti-goals (failure even if it "works")

- Any state where unread articles exist on the server but the phone shows a stale list with no way out except a long foreground wait.
- A rebuild that wipes a readable library before the new one is ready.
- Read articles silently reappearing as unread, or unread counts disagreeing with the lists.
- Breaking TestFlight 4401, which must keep working against the new Worker (CLAUDE.md: keep the API backward compatible).
- Exceeding the Worker's 10 ms Free-plan CPU budget on any new endpoint (see `SYNC_PAGE_BODY_BUDGET` in `src/sync-api.ts`).

## Approaches considered

- **A. Unread list first, bodies in the background (chosen).** A rebuild fetches metadata for unread, starred and saved articles (a few MB, seconds), then a resumable queue downloads bodies newest first. Most new code, best fit for "unread first".
- **B. Unread articles with bodies in one pass.** Same set, bodies inline through the existing apply path. Less code, but about 120 MB in a few hundred pages, so folders stay wrong for minutes and the pass still needs to resume after interruptions.
- **C. Replay only recent change-log history.** Least server work, but unread articles older than the cutoff disappear from the phone, which works against the goal.

Hans picked A.

## Design

### 1. Server: metadata listing for the rebuild

New authenticated endpoint on the native API (`src/native-api.ts`), e.g. `GET /api/v1/library`:

- Returns feeds (same payload as sync feed changes, including folders) and article **metadata** for: unread articles, starred articles, Read It Later items, and read articles received in the last 7 days (by `received_at`; keeps recently read stories in lists so they do not visibly change shape). Metadata is the sync article payload without `html` and `text`, plus each body's size in bytes and its content version, so the phone can plan and verify body downloads.
- The first page records `MAX(sync_changes.sequence)` **before** reading any rows and returns it as an `/api/v1/sync` cursor (`v1:<n>`). Later pages carry it forward. After the listing, the phone resumes incremental sync from that cursor. A change that lands during the listing is re-delivered by sync; applies are idempotent upserts, so that is harmless.
- Keyset pagination by `items.rowid` (stable, resumable). Page size bounded by row count and response bytes so CPU stays under budget; measure with `wrangler tail --format json` (`cpuTime`).
- Additive only. No schema bump needed unless an index is required for "unread or starred ordered by rowid"; if one is, it goes in a migration, not a hotfix.

### 2. Server: bodies by ID

Reuse `POST /reader/api/0/stream/items/contents` (already used by `PigeonAPIClient.streamItems`, chunked and run concurrently). The builder checks its CPU cost for large bodies and adds a byte bound if needed (the phone can size batches using the body sizes from the listing). A new native endpoint is acceptable if the Google Reader one cannot be bounded cleanly.

### 3. iOS: rebuild = listing + swap

- `beginFullRebuild` keeps its staging generation. The listing writes metadata rows into staging. The staging marker (`cache_rebuilds`) also stores progress (snapshot cursor + last rowid), so an interrupted listing resumes instead of deleting the stage. The stage is deleted only when a new rebuild is genuinely needed (format change, or a stage older than some limit).
- When the listing completes: swap staging in as the committed library (as `finishSynchronization` does today), then run incremental sync from the snapshot cursor, then start the body queue.
- The committed library stays visible and usable throughout. The swap is the only moment the user's library changes.
- The listing is the whole truth for the new library: nothing is carried over from the old committed library except bodies already downloaded for articles that are in the listing (match by ID and content version), and pending local mutations, which stay overlaid as they are today (`loadPendingStatusOverlays`). An article the phone thought unread but the server has read or deleted is simply absent or read after the swap. My call, chosen so the swap can never leave stale unread state.
- Older read articles are not on the phone after a rebuild. Folder lists still page older items from the server on scroll, as today. Read articles that arrive later through incremental sync stay as they do now (existing body pruning applies); there is no ongoing retention job, so a long-lived library and a freshly rebuilt one may differ in how many old read articles they hold. Accepted: unread state is identical in both.

### 4. iOS: body download queue

- A persisted queue of article IDs needing bodies: unread first, newest first, then starred and saved.
- Runs after a rebuild and after any sync page that adds unread articles. Survives app suspension and relaunch, and resumes from what is still missing (derive "missing" from the store rather than a separate list if that is simpler).
- Batches sized by bytes using the listing's body sizes. Writes each batch in its own transaction, so progress is never lost.
- Respects the existing network policy (`BackgroundRefreshPolicy`, Low Data Mode setting). My call: no separate storage cap now; unread bodies are about 120 MB today, and existing read-body pruning still applies.
- Runs while the app is open, and also in the existing background refresh (`BGAppRefreshTask`): after its incremental sync, it spends the rest of the task's time on the queue and stops cleanly at expiration (7aa474fb already forwards expiration to the sync task). Hans asked for whatever makes the app feel fastest: new unread articles should already have their text when he opens the app. My call: no background `URLSession` or `BGProcessingTask` in this project; add them later only if the refresh windows prove too short.
- Opening an article without a body fetches that body immediately, ahead of the queue, and shows a loading state in the reader rather than an empty page.

### 5. iOS: "no body yet" is a normal state

Today `cachedCollectionHasMissingBodies` (ReaderAppModel, used in `refreshCollection`, `loadForDisplay` and the initial-feed pagination check) treats any article without HTML as a reason to reload the collection from the network. After this change an unread article can legitimately have no body for a while. The builder must separate "body not downloaded yet" from "collection incomplete", and keep the existing distinction between pruned bodies and missing ones.

### 6. iOS: refresh never waits on a rebuild or the body queue

- Pull-to-refresh and the Refresh command: replay pending mutations, run one incremental sync if the cache is usable, reload the visible collection, and return. If a rebuild is running, they do not await it; they reload the visible collection from the server (the existing live path) and return.
- Today `refreshCollection` awaits `prepareOfflineLibrary(force: true)`. That coupling is what turns a long sync into an endless spinner, and it goes.

### 7. iOS: repair in place instead of rebuilding

- A status change for an article the phone does not hold (`OfflineLibraryError.missingStatusTarget`) no longer fails the page. My call: skip it and enqueue that article ID for a metadata fetch. The server only emits a status after the article's own event, so this only happens for articles the phone intentionally does not keep.
- A single malformed change is skipped and logged (the existing `invalidChangeCount` can track it) instead of failing the whole page. Repeated structural failures across launches may still escalate to a rebuild, which is now cheap.
- A full rebuild remains for: cache format version change, an unreadable database, or the user's "Clear saved articles".

## Constraints

- Worker code: Web APIs only, TypeScript strict, ESM, D1 writes via `DB.batch()`, no no-op writes to `items` (see CLAUDE.md).
- Never delete `sync_changes` rows.
- iOS: run `xcodegen generate` after adding files; tests on the `Pigeon Claude` simulator.
- API changes are additive; 4401 keeps using `/api/v1/sync` unchanged.
- Order of work: API, then iOS (the web app is not affected).

## Left to the builder

- Endpoint names, exact payload shapes, page sizes and byte bounds (measured against the 10 ms CPU budget).
- Whether to add a native body endpoint or bound the Google Reader one.
- Store schema for the body state and queue, and the migration of existing caches.
- How the reader view shows a body that is still loading, within `DESIGN.md`.
- How to split the work into PRs (suggested: server endpoints; iOS refresh decoupling plus repair-in-place; iOS listing rebuild plus body queue).

## Shipping

Hans's call: everything ships together at the end, in one Worker deploy and one TestFlight release (which also carries 7aa474fb). No interim release of the spinner fix. Order of work stays API, then iOS; the Worker deploy must precede the TestFlight release, since the new build needs the new endpoints.

## Testing expectations

- Server: unit tests for listing pagination, the snapshot cursor, the byte bound, and that the listing plus subsequent sync converge to the same state as a full replay for unread, starred and saved articles.
- iOS: store tests for resume after interruption at every stage (mid-listing, after swap before sync, mid-body-queue), status-for-missing-article skip, and that refresh returns while a rebuild is in progress. Repeated runs per CLAUDE.md's lifecycle rules.
- Manual: on a device with a large library, a rebuild shows correct folders within seconds; backgrounding mid-rebuild and returning resumes rather than restarts (check with `wrangler tail`).
