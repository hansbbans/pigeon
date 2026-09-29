#!/usr/bin/env python3
"""Fixture coverage for path routing, complete change ranges, and fail-closed gates."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import sys
sys.dont_write_bytecode = True
from unittest.mock import patch

from ci_scope import classify, changed_paths, scope, validate_gate


class ScopeTests(unittest.TestCase):
    def test_documentation_and_release_tooling_skip_native(self):
        cases = {
            "pigeon": ["README.md", "08-testing/TESTING.md", "docs/testflight-release.md", "scripts/testflight-ci-gate.mjs", "test/testflight-ci-gate.test.mjs"],
            "todomd": ["CHANGELOG.md", "docs/testflight-monitoring.md", "Tools/assign_testflight_groups.rb", "scripts/tests/testflight_monitor_test.rb"],
            "swole": ["SwoleMCP/README.md", "scripts/testflight-monitor.md", "scripts/release_testflight.sh", "scripts/tests/testflight_monitor_test.rb"],
        }
        for repo, paths in cases.items():
            with self.subTest(repo=repo):
                self.assertEqual(classify(repo, paths), {"native": False, "worker": False, "unknown": []})

    def test_unknown_app_build_dependencies_and_workflows_require_native(self):
        paths = ["future-tool.py", "project.yml", "Package.resolved", "package-lock.json", "scripts/ExportOptions-TestFlight.plist", ".github/workflows/ci.yml", ".github/scripts/ci_scope.py", "docs/generated.json", "docs/embedded.swift", "/README.md", "docs/../README.md"]
        native_files = {"pigeon": "ios/PigeonReader/App.swift", "todomd": "Sources/TodoMDApp/App.swift", "swole": "Swole/App/App.swift"}
        for repo in native_files:
            for path in [*paths, native_files[repo]]:
                with self.subTest(repo=repo, path=path):
                    result = classify(repo, ["README.md", path])
                    self.assertTrue(result["native"])
                    self.assertEqual(result["worker"], repo == "pigeon")

    def test_pigeon_backend_only_runs_worker(self):
        for path in ["src/greader.ts", "test/api-auth.test.ts", "test/fixtures/email.eml", "migrations/001.sql"]:
            result = classify("pigeon", [path, "README.md"])
            self.assertFalse(result["native"])
            self.assertTrue(result["worker"])
        self.assertTrue(classify("pigeon", ["src/greader.ts", "ios/PigeonReader/App.swift"])["native"])

    def test_empty_and_forced_scope_run_full_validation(self):
        for repo in ("pigeon", "todomd", "swole"):
            for paths, force in [([], False), (["README.md"], True)]:
                self.assertTrue(classify(repo, paths, force)["native"])

    def test_git_ranges_include_all_pr_commits_deletions_and_rename_destinations(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {"GIT_CONFIG_NOSYSTEM": "1"}):
            def git(*args):
                return subprocess.check_output(["git", "-C", temp, *args], text=True).strip()
            git("init", "-q")
            git("config", "user.name", "CI fixture")
            git("config", "user.email", "ci@example.invalid")
            Path(temp, "unknown.swift").write_text("app code")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            git("mv", "unknown.swift", "README.md")
            git("commit", "-qm", "rename app to docs")
            Path(temp, "CHANGELOG.md").write_text("docs")
            git("add", ".")
            git("commit", "-qm", "second commit")
            head = git("rev-parse", "HEAD")
            previous = os.getcwd()
            try:
                os.chdir(temp)
                event = {"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}
                paths = changed_paths("pull_request", event)
                self.assertEqual(set(paths), {"unknown.swift", "README.md", "CHANGELOG.md"})
                self.assertTrue(classify("swole", paths)["native"])
                self.assertEqual(set(changed_paths("push", {"before": base, "after": head})), set(paths))
            finally:
                os.chdir(previous)

    def test_scheduled_or_unreadable_baselines_fail_closed(self):
        for event_name, payload in [("schedule", {}), ("push", {"before": "0" * 40, "after": "a" * 40}), ("pull_request", {})]:
            with tempfile.TemporaryDirectory() as temp:
                event = Path(temp, "event.json")
                event.write_text(json.dumps(payload))
                output, summary = Path(temp, "output"), Path(temp, "summary")
                env = {"GITHUB_EVENT_NAME": event_name, "GITHUB_EVENT_PATH": str(event), "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)}
                with patch.dict(os.environ, env):
                    scope("pigeon")
                self.assertIn("native=true", output.read_text())
                self.assertIn("worker=true", output.read_text())


class GateTests(unittest.TestCase):
    def needs(self, native="true", worker="true"):
        return {"scope": {"result": "success", "outputs": {"native": native, "worker": worker}},
                "tooling": {"result": "success"},
                "native": {"result": "success" if native == "true" else "skipped"},
                "worker": {"result": "success" if worker == "true" else "skipped"}}

    def test_full_docs_and_backend_scopes_accept_only_expected_results(self):
        for native, worker in [("true", "true"), ("false", "false"), ("false", "true")]:
            for repo in ("pigeon", "todomd", "swole"):
                self.assertEqual(validate_gate(repo, self.needs(native, worker)), [])

    def test_failures_cancellations_and_unexpected_skips_do_not_pass(self):
        for job in ("scope", "tooling", "native", "worker"):
            for status in ("failure", "cancelled", "skipped", None):
                needs = self.needs()
                needs[job]["result"] = status
                self.assertTrue(validate_gate("pigeon", needs), (job, status))

    def test_scope_output_missing_invalid_or_empty_does_not_pass(self):
        for value in (None, "", "yes", True):
            needs = self.needs()
            needs["scope"]["outputs"]["native"] = value
            self.assertTrue(validate_gate("pigeon", needs))
        for job in self.needs():
            needs = self.needs()
            del needs[job]
            self.assertTrue(validate_gate("pigeon", needs))

    def test_intentional_skips_cannot_mask_failed_suites(self):
        for job in ("native", "worker"):
            for status in ("failure", "cancelled", "success"):
                needs = self.needs("false", "false")
                needs[job]["result"] = status
                self.assertTrue(validate_gate("pigeon", needs))


if __name__ == "__main__":
    unittest.main()
