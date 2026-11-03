# API contract fixtures

These files are the contract between the Pigeon Worker and the PigeonReader iOS app.
Both sides test against them:

- `test/api-contract.test.ts` (Worker job) sends the iOS app's requests through the real
  Worker router and requires each response to equal its `*.response.*` fixture.
- `ios/PigeonReader/PigeonReaderTests/Core/APIContractTests.swift` (native job) decodes
  every response fixture with the app's production `PigeonAPIClient`, and checks that
  the app still encodes the `*.request.json` bodies.
- The Worker job also fails if a fixture in this folder is not named in
  `APIContractTests.swift`, so a new fixture can't skip the iOS check. The Worker job
  refuses `UPDATE_CONTRACT_FIXTURES=1` when `CI` is set.

**Changing a fixture is an API change.** The build on TestFlight (and in users' hands)
was compiled against the current fixtures, and a Worker deploy reaches it immediately.
Keep changes backward compatible: add optional fields rather than renaming, removing,
retyping, or changing the meaning of existing ones. If an incompatible change is
unavoidable, ship an app build that reads both shapes first, and only then change the
Worker.

## Files

| Fixture | Endpoint |
| --- | --- |
| `client-login.response.txt` | `POST /accounts/ClientLogin` |
| `sync.response.json` | `GET /api/v1/sync` |
| `mutations.request.json` | `POST /api/v1/mutations` body sent by the app |
| `mutations.response.json`, `mutations-replay.response.json` | `POST /api/v1/mutations` (applied, then replayed) |
| `sync-after-mutations.response.json` | `GET /api/v1/sync` after those mutations |
| `engagement.request.json` | `POST /api/v1/engagement` body sent by the app |
| `personalization.response.json` | `GET /api/v1/personalization` |
| `personalization-update.response.json` | `PUT /api/v1/personalization` |
| `subscription-list.response.json` | `GET /reader/api/0/subscription/list` |
| `unread-count.response.json` | `GET /reader/api/0/unread-count` |
| `stream-item-ids.response.json` | `GET /reader/api/0/stream/items/ids` |
| `stream-item-contents.response.json` | `POST /reader/api/0/stream/items/contents` |
| `quickadd.response.json` | `GET /reader/api/0/subscription/quickadd` |
| `recommendations-for-you.response.json`, `recommendations-unread.response.json` | `GET /api/v1/recommendations` |
| `readwise-token.response.json` | `GET /api/v1/readwise/token` |
| `app-status.response.json` | `GET /app/status` |
| `stale-feeds.response.json` | `GET /api/v1/stale-feeds` |

Values are deterministic: the test pins the clock to `2026-11-01T12:00:00.000Z` and the
SQLite `datetime('now')` stamps of the sync log to `2026-11-01 11:00:00`.

## Regenerating

After an intentional, backward compatible response change:

```sh
UPDATE_CONTRACT_FIXTURES=1 npx tsx --test test/api-contract.test.ts
```

Review the diff as an API change, then run the iOS unit tests (`APIContractTests`) so
the app proves it still reads the new fixtures. Request fixtures are never regenerated;
edit them by hand when the app's request encoding changes.

Changes in this folder run both the Worker and the native CI jobs.
