# CLAUDE.md

Pigeon is a Cloudflare Worker that turns newsletters and RSS into Atom feeds and a Google Reader style API, plus the PigeonReader iOS app in `ios/PigeonReader`. How it works and how to deploy: `README.md`. CI rules: `docs/ci-validation.md`. Release: `docs/testflight-release.md`. The numbered `0x-*/` folders are the original design documents, not current state.

## Workspace
- The primary checkout `~/code/pigeon` stays on `main` and clean. Multi-file work goes in a worktree from `origin/main`: `git worktree add ../pigeon-<topic> -b claude/<topic> origin/main`. Remove it after the PR merges.
- Unexpected modified files belong to another session: never commit, revert, or format them.

## Worker
- Checks: `npm run check` (tests, typecheck, audit); `npm test` for a quick loop.
- **deploy** means `npm run deploy` (ships `pigeon-recommendations`, then `pigeon`). CI never deploys, so production drifts behind `main`. Before deploying: compare `npx wrangler deployments list` with `main`, and read the live schema with `npx wrangler d1 execute pigeon-db --remote --command "SELECT value FROM _meta WHERE key='schema_version'"`. Schema bumps are one-way (an older Worker throws on a newer schema), so keep them out of hotfixes. Afterwards check `https://pigeon.hanscho.com/health` and report the deployed commit. No D1 restore point before deploys; Hans declined that.
- Production bugs: check live data and the live Worker version before reading code.
- Writers to `items` must avoid no-op updates (they bloat `sync_changes`, see the compaction in the sync route). Never delete `sync_changes` rows; web push relies on each article's first event.

## iOS
- `xcodegen generate` in `ios/PigeonReader` after adding or removing files.
- Tests: `xcodebuild test -project ios/PigeonReader/PigeonReader.xcodeproj -scheme PigeonReader -destination 'platform=iOS Simulator,name=Pigeon Claude' -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO`. Boot `Pigeon Claude` first; never use the shared `iPhone 17 Pro`.
- Design rule: the reader must not look like Mail. No sender/subject/preview rows, no swipe-to-triage as the main interaction, no unread dots as the organizing idea. Lean editorial or magazine. Before proposing a redesign, ask what Hans dislikes about the current screen.

## CI and the shared Mac
- The iOS job takes about 40 minutes and runs on the self-hosted Mac behind a cross-repo iOS runner lock. Never `gh run cancel` an iOS job: a cancelled job leaves `xcodebuild` orphans that push the load average into the hundreds. If the Mac is slow, `ps -Ao pid,etime,command | grep "xcodebuild test"`, kill only orphans from finished runs, then `gh run rerun <id> --failed`.
- Scope filters: Worker-only changes (`src/`, `test/`, `migrations/`, npm manifests) skip the iOS job; documentation skips both; unknown paths run everything.
- Merging needs `CI required validation` plus the `Workstream reviewed head` status on the exact head. Post that status only after reviewing the PR (`/code-review` or a self-review subagent) and fixing what it found:
  `gh api repos/hansbbans/pigeon/statuses/<sha> -f state=success -f context="Workstream reviewed head" -f description="Reviewed by Claude: <one-line summary>"`.
  Then merge with a merge commit and confirm `main` is green.

## Release
- **release** / **testflight**: from a clean `main`, `node scripts/release-new-build-to-testflight.mjs --monitor-state /tmp/pigeon-release-request.json --monitor-receipt /tmp/pigeon-release-receipt.json`. It dispatches `Release to TestFlight` for the exact remote `main` SHA, waits for the upload and App Store Connect verification, and prints a receipt with version and build. Resume an interrupted wait with `--resume-monitor` on the same state file; never dispatch twice. The workflow tags the released commit `testflight/<build>` (best effort: a failed tag push does not fail the release).
- Before releasing, add a `## [<version>] - <date>` entry to `CHANGELOG.md` and keep `VERSION` in step with it, in a PR. Those files are the project's own release log; the TestFlight marketing version comes from `ios/PigeonReader/project.yml` (or `--marketing-version`), and the build number from the workflow run. If `main` is already on TestFlight, say so in one line with the build number.
