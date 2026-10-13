# Web reader feature parity

Implementation order requested by Hans, 2026-10-12. Continue PR #126 and preserve unrelated PR #125. No production deployment or merge is authorized by this implementation request.

## Acceptance checklist

- [x] Read/unread and stars: persistent toggles, Starred view, read indicators, undo, optional automatic read, race/session-safe state.
- [x] Search/filter/sort: usable search, All/Unread/Read filters, newest/oldest ordering and For You score ordering, coherent paginated results; bulk above/below/age read and undo.
- [x] Library management: add/discover RSS and YouTube, rename/unsubscribe, multi-folder assignment and folder rename/delete, OPML preview/import, stale-feed cleanup/undo.
- [x] For You: recommendations, scores/explanations, feedback, monitored topics and personalization history/delete/export/reset.
- [x] Reading controls and integrations: typography/themes/density, reader modes and feed preference, image privacy/zoom, sharing/Readwise, keyboard preferences and reading position.
- [x] Offline: persistent article library, account-safe queued edits/replay, storage controls and protected unread/starred content.
- [x] Notifications: per-feed opt-in with clearly stated browser support and background delivery requirements; read/star actions where supported.

## Verification requirements

Each stage needs meaningful API/state regression coverage and type checking. Final acceptance includes actual desktop and narrow-screen interaction, success/failure/retry paths, session isolation, persistence/reload behavior, and no unrelated changes. Record browser restrictions explicitly rather than implying unsupported native parity.

Existing baseline: PR #126 has 631 passing tests and type checking; CI security audit fails on the dependency chain covered by PR #125. Production currently has no individual read/unread or star controls.

Stage 1: commit `5f10c39`; 652 combined tests and TypeScript passed. Root browser verified star/Starred/unstar/undo and unread persistence using local fixture; final diff reviewed. No production writes.

Stage 2 browser verification: real Worker-backed local fixture passed full-text search, unread filtering, oldest-first sorting, search-scoped Mark All, bulk Undo with restored unread counts, and authenticated reload persistence. Automated regressions cover all paginated matching articles, neutral bulk recommendation signals, partial receipts, idempotent Undo retry, and local-day cursor rollover. Recommended ordering is covered in Stage 4.

Offline module verification: `8e4302c`, 15 focused tests and TypeScript passed. Root used an actual browser with real IndexedDB to verify sync, concurrent two-client enqueue order, durable queue after close/reopen, ordered receipt replay, saved-body search, unread/starred filters, protected cleanup, and account-session rejection. Full app integration and service-worker navigation are separate acceptance checks.

Reader extraction verification: `b7e2bee` with smoke harness repair `168239e`. Root ran `PIGEON_READABILITY_CUA_SMOKE=1 npx tsx --test test/browser-readability.test.ts` and visited its disposable local fixture through CUA. All three checks passed: native vendor/notice identity, emitted-script safety, and real-browser article extraction with correct relative URLs, no executed injected script, no active unsafe markup, and zero source resource requests. Browser smoke is explicitly opt-in; the normal suite runs deterministic checks only.

Stages 3–4: `a333a73`, `1fcdab5`, `7bf470d`. Root browser verified feed rename and multiple-folder assignment (including literal commas), Undo, unsubscribe/restore, OPML nested-folder preview, stale-feed loading, and preserving the active folder through rename/Undo. The rendered-page check found invalid script escaping; fixed and covered by parsing every inline script from actual rendered HTML. For You displayed a qualifying unread story with score 90 and its monitored-topic explanation. More Like This appeared in confirmed history, monitored-topic changes saved, the JSON export became available, and Not Interested removed the story from recommendations. Backend/state tests cover deletion/reset and failure/session races; no production library or personalization changes were made.

Stage 5 browser evidence: Reader extraction displayed the local fixture's extracted story; Sepia/Serif/20px preferences saved and rendered; Website mode explained its separate-tab fallback; Readwise's simulated token rejection preserved the Pigeon session. Newsletter Ask mode made zero fixture image requests until explicit consent, then exactly one. The real-DOM image-policy smoke (`PIGEON_READING_CUA_SMOKE=1 npx tsx --test test/browser-reading-preferences.test.ts`) passed all 10 checks, including proxy blob display and stale-session URL revocation. Desktop and 390×844 views were inspected; viewport override restored.

Stage 6 browser evidence: saved two articles and two bodies, disabled fixture connectivity without resetting its SQLite database, reloaded from the cached app shell, queued unread/star changes, reloaded again with both edits preserved, reconnected, synced two pending edits to zero, and confirmed both states after an online reload. Server read state confirmed the replay. Follow-up browser checks also passed: acknowledged online read/star edits survived an immediate offline reload without a manual sync, and a fresh offline tab accepted the saved account password and displayed its saved library with a clear offline banner.

Stage 7 limitation: local browser displayed the disabled server-configuration state and did not ask for notification permission. Encrypted payload/provider handling and subscription recovery have automated coverage. Live delivery requires VAPID deployment configuration, browser permission, and a subsequent scheduled refresh; no live push-delivery claim is made.

Final validation: 779 automated tests passed, with two explicitly opt-in browser smoke tests skipped in the default suite; both smoke fixtures were separately exercised successfully through CUA as recorded above. TypeScript and whitespace checks passed. The security audit still reports the existing three high-severity findings through sharp/miniflare/wrangler; their dependency fix belongs to PR #125 and was preserved. No native files, dependencies, release versions, or production data were changed.
