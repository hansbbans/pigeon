# CLAUDE.md

Pigeon is a Cloudflare Worker that turns newsletters and RSS into Atom feeds and a Google Reader style API, plus the PigeonReader iOS app in `ios/PigeonReader`. How it works and how to deploy: `README.md`. CI rules: `docs/ci-validation.md`. Design system for iOS and the web app: `DESIGN.md`. Release: `docs/testflight-release.md`. The numbered `0x-*/` folders are the original design documents, not current state.

## Workspace
- The primary checkout `~/code/pigeon` stays on `main` and clean. Multi-file work goes in a worktree from `origin/main`: `git worktree add ../pigeon-<topic> -b claude/<topic> origin/main`. Remove it after the PR merges.
- Unexpected modified files belong to another session: never commit, revert, or format them.

## Worker
- Checks: `npm run check` (tests, typecheck, audit); `npm test` for a quick loop.
- **deploy** means `npm run deploy` (ships `pigeon-recommendations`, then `pigeon`). CI never deploys, so production drifts behind `main`. Before deploying: compare `npx wrangler deployments list` with `main`, and read the live schema with `npx wrangler d1 execute pigeon-db --remote --command "SELECT value FROM _meta WHERE key='schema_version'"`. Schema bumps are one-way (an older Worker throws on a newer schema), so keep them out of hotfixes. Afterwards check `https://pigeon.hanscho.com/health` and report the deployed commit. No D1 restore point before deploys; Hans declined that.
- Production bugs: check live data and the live Worker version before reading code.
- Worker invariants: dates are ISO 8601 UTC; Atom entries wrap HTML in CDATA; the email handler catches and logs instead of rethrowing (a rethrow makes Cloudflare retry the message); D1 rows are capped at 1 MB, so check content size before inserting (`MAX_CONTENT_SIZE` in `src/email-handler.ts`); dedupe with `INSERT OR IGNORE` against the `message_id` UNIQUE index; the email handler cannot run locally, so test it with saved `.eml` fixtures.
- Code conventions: TypeScript strict, ESM only. Worker code in `src/` uses Web APIs only (no `fs`, `Buffer`, `require()`, `node:` imports, even though `nodejs_compat` is on); Node is fine in `scripts/`. Parse email with `postal-mime` (`mailparser` does not run in Workers). Atom output is hand-rolled in `src/feed.ts` (the `feed` npm package needs Node); `fast-xml-parser` is used only on the input side, in `src/rss-parser.ts`. IDs come from `crypto.randomUUID()`; multi-statement D1 writes go through `DB.batch()`. Feed keys are URL-safe lowercase (`normalizeFeedKey` in `src/normalize.ts`).
- Writers to `items` must avoid no-op updates (they bloat `sync_changes`, see the compaction in the sync route). Never delete `sync_changes` rows; web push relies on each article's first event.

## iOS
- `xcodegen generate` in `ios/PigeonReader` after adding or removing files.
- Tests: `xcodebuild test -project ios/PigeonReader/PigeonReader.xcodeproj -scheme PigeonReader -destination 'platform=iOS Simulator,name=Pigeon Claude' -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO`. Boot `Pigeon Claude` first; never use the shared `iPhone 17 Pro`.
- Fast local loop: add `-only-testing:PigeonReaderTests` plus `-only-testing:PigeonReaderUITests/<Class>` for only the UI test classes you touched. The full UI suite (77 tests, about 28 minutes) is CI's job: nightly, `CI` dispatched with `ui_suite: full`, or the release.
- Do not rename or remove a test in `.github/ios-smoke-ui-tests.txt` without updating the list.
- Design rule: the reader must not look like Mail. No sender/subject/preview rows, no swipe-to-triage as the main interaction, no unread dots as the organizing idea. Lean editorial or magazine. Before proposing a redesign, ask what Hans dislikes about the current screen.

## CI and the shared Mac
- Suites (details in `docs/ci-validation.md`): PRs and pushes to `main` run all iOS unit tests plus the smoke UI tests in `.github/ios-smoke-ui-tests.txt`. The nightly run (08:00 UTC, skipped when `main` has not changed since its last full run) and `gh workflow run ci.yml --ref main -f ui_suite=full` run every UI test. A TestFlight release reuses CI only from a green full-suite run of the exact commit; otherwise it runs every test itself.
- A full iOS job takes about 35 minutes (28 of them UI tests) and runs on the self-hosted Mac behind a cross-repo iOS runner lock. Never `gh run cancel` an iOS job: a cancelled job leaves `xcodebuild` orphans that push the load average into the hundreds. If the Mac is slow, `ps -Ao pid,etime,command | grep "xcodebuild test"`, kill only orphans from finished runs, then `gh run rerun <id> --failed`.
- Scope filters: Worker-only changes (`src/`, `test/`, `migrations/`, npm manifests) and the browser extension (`extension/`) skip the iOS job; documentation skips both; unknown paths run everything.
- Merging needs `CI required validation` plus the `Workstream reviewed head` status on the exact head. Post that status only after reviewing the PR (`/code-review` or a self-review subagent) and fixing what it found:
  `gh api repos/hansbbans/pigeon/statuses/<sha> -f state=success -f context="Workstream reviewed head" -f description="Reviewed by Claude: <one-line summary>"`.
  Then merge with a merge commit and confirm `main` is green.

## Working across web and iOS
- Web-only PRs (`src/`, `test/`) never use the Mac, so run web and iOS work in parallel worktrees.
- For cross-platform features, build API, then web, then iOS.
- Batch `.github`/CI edits into one PR: any change under `.github` runs the native iOS job on the shared Mac.
- Keep the API backward compatible with the build currently on TestFlight.
- After web UI changes, run `npm run visual:check` (local only, not CI; first time `npx playwright install chromium`). It starts both Workers on a fresh local D1 with a throwaway password, screenshots `/app` (login, reader, settings, library) at 375/768/1280 px into gitignored `visual-check/`, and fails on console errors or non-2xx responses. `-- --base-url <url>` checks a running server; signed-in pages then need `PIGEON_API_PASSWORD`.

## Release
- **release** / **testflight**: from a clean `main`, `node scripts/release-new-build-to-testflight.mjs --monitor-state /tmp/pigeon-release-request.json --monitor-receipt /tmp/pigeon-release-receipt.json`. It dispatches `Release to TestFlight` for the exact remote `main` SHA, waits for the upload and App Store Connect verification, and prints a receipt with version and build. Resume an interrupted wait with `--resume-monitor` on the same state file; never dispatch twice. The workflow tags the released commit `testflight/<build>` (best effort: a failed tag push does not fail the release).
- Before releasing, add a `## [<version>] - <date>` entry to `CHANGELOG.md` and keep `VERSION` in step with it, in a PR. Those files are the project's own release log; the TestFlight marketing version comes from `ios/PigeonReader/project.yml` (or `--marketing-version`), and the build number from the workflow run. If `main` is already on TestFlight, say so in one line with the build number.
