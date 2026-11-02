# CI validation

Every main push and pull request runs CI; no workflow-level path filters hide the required check. CI also runs nightly on `main` and on demand through `workflow_dispatch`. `CI required validation` always reports whether all selected validation succeeded. A failed, cancelled, unexpectedly skipped, or missing selected job fails that check.

CI classifies the complete pull request change range from its merge base, or the complete main push range. Deleted paths and both sides of renames participate. Unavailable history, empty diffs, and scheduled runs select full validation.

Native validation runs for app code, project/build configuration, dependencies, workflow changes, CI helpers, and every unrecognized path. Only explicitly known Markdown documentation and enumerated release helpers/tests can skip native validation. Pigeon's recognized backend TypeScript tests/code, fixtures, and SQL migrations run Worker checks without native validation. Mixed changes select every necessary suite. Tooling fixtures always run on Linux.

The allowlists and fail-closed gate are in `.github/scripts/ci_scope.py`; fixture tests are in `.github/scripts/test_ci_scope.py`. A new path needs an explicit policy decision before it can skip native validation. Native jobs preserve existing self-hosted runner and simulator cleanup behavior. Fork app changes cannot run on the trusted self-hosted runner and fail the required gate rather than claim native proof.

## Smoke, full, nightly, and release test suites

The native job always runs every iOS unit test (`PigeonReaderTests`) and the clean Release build. Which UI tests it runs depends on the trigger:

| Trigger | UI tests | Native step | Counts as release evidence |
| --- | --- | --- | --- |
| Pull request | Smoke list | `Run unit and smoke UI tests` | No |
| Push to `main` | Smoke list | `Run unit and smoke UI tests` | No |
| Nightly schedule (08:00 UTC, `main`) | All, including `PigeonMotionPerformanceUITests` | `Run unit and full UI tests` | Yes |
| `workflow_dispatch`, `ui_suite: full` (default) | All | `Run unit and full UI tests` | Yes, when run on `main` |
| `workflow_dispatch`, `ui_suite: smoke` | Smoke list | `Run unit and smoke UI tests` | No |
| TestFlight release without reusable evidence | All (whole scheme, no `-only-testing`) | `Run Pigeon tests` in the release workflow | Not applicable |

The smoke list is `.github/ios-smoke-ui-tests.txt`, one `-only-testing` identifier (`PigeonReaderUITests/Class/testMethod`) per line. `.github/scripts/run-ios-tests.sh smoke` turns it into `-only-testing:PigeonReaderTests` plus one `-only-testing:` flag per entry; `DRY_RUN=1` prints the command without running it. xcodebuild silently runs nothing for an identifier that no longer exists, so two guards fail CI instead: `.github/scripts/ios_smoke_tests.py check` (in the tooling job and before the smoke run) requires every entry to name a test method in `ios/PigeonReader/PigeonReaderUITests/*.swift`, and `verify-log` after the run requires xcodebuild to report every entry as passed (a skipped smoke test fails) and a passing unit-test run with at least one test. Fixture tests are in `.github/scripts/test_ios_smoke_tests.py`. Rename or remove a smoke test and its list entry in the same change.

`ci_scope.py` writes the `ui_suite` output (`smoke` for pull requests and pushes, `full` for everything else, including unreadable events) and the required gate rejects a missing or invalid value. Scheduled and dispatched runs have no change range, so they always select full native and Worker validation. The nightly run first asks `scripts/testflight-ci-gate.mjs --full-suite-exists` whether an earlier run already proved the current `main` HEAD with the full suite; if so it skips both suites (the required gate still reports green), so the nightly only does native work when `main` changed. Unreadable evidence runs the full suite.

A TestFlight release reuses CI only from a green exact-SHA `main` run (push, schedule, or dispatch) whose `Run unit and full UI tests` and `Clean Release build` steps succeeded. A smoke-only run never qualifies, and a non-green run newer than the full run forces full release tests. In practice: release after the nightly has run on that commit, or dispatch CI with `ui_suite: full` on `main` first; otherwise the release workflow runs every test itself.

## Cancellation

Superseded pull request runs are cancelled. Main and scheduled CI runs and TestFlight releases are not cancelled by that policy. The release workflows retain their separate non-cancelling concurrency groups.

Require `CI required validation` in branch protection instead of individual conditional suite checks. Repository settings are separate from this workflow change. Pigeon release reuse still requires successful exact-main scope, tooling, gate, Worker, full-suite native tests, and clean Release build steps; a proportional green CI run with skipped native validation, or a smoke-only run, falls back to full release tests.
