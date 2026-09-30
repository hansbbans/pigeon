# CI validation

Every main push and pull request runs CI; no workflow-level path filters hide the required check. `CI required validation` always reports whether all selected validation succeeded. A failed, cancelled, unexpectedly skipped, or missing selected job fails that check.

CI classifies the complete pull request change range from its merge base, or the complete main push range. Deleted paths and both sides of renames participate. Unavailable history, empty diffs, and scheduled runs select full validation.

Native validation runs for app code, project/build configuration, dependencies, workflow changes, CI helpers, and every unrecognized path. Only explicitly known Markdown documentation and enumerated release helpers/tests can skip native validation. Pigeon's recognized backend TypeScript tests/code, fixtures, and SQL migrations run Worker checks without native validation. Mixed changes select every necessary suite. Tooling fixtures always run on Linux.

The allowlists and fail-closed gate are in `.github/scripts/ci_scope.py`; fixture tests are in `.github/scripts/test_ci_scope.py`. A new path needs an explicit policy decision before it can skip native validation. Native jobs preserve existing self-hosted runner and simulator cleanup behavior. Fork app changes cannot run on the trusted self-hosted runner and fail the required gate rather than claim native proof.

Superseded pull request runs are cancelled. Main and scheduled CI runs and TestFlight releases are not cancelled by that policy. The release workflows retain their separate non-cancelling concurrency groups.

Require `CI required validation` in branch protection instead of individual conditional suite checks. Repository settings are separate from this workflow change. Pigeon release reuse still requires successful exact-main scope, tooling, gate, Worker, native tests, and clean Release build steps; a proportional green CI run with skipped native validation falls back to full release tests.
