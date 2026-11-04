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

from ci_scope import classify, changed_paths, safari_scope, scope, ui_suite, validate_gate


class ScopeTests(unittest.TestCase):
    def test_documentation_and_release_tooling_skip_native(self):
        cases = {
            "pigeon": ["README.md", "CLAUDE.md", "08-testing/TESTING.md", "docs/testflight-release.md", "scripts/testflight-ci-gate.mjs", "test/testflight-ci-gate.test.mjs"],
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
            for path in [*paths, *([] if repo == "pigeon" else ["package.json"]), native_files[repo]]:
                if repo == "pigeon" and path == "package-lock.json":
                    continue
                with self.subTest(repo=repo, path=path):
                    result = classify(repo, ["README.md", path])
                    self.assertTrue(result["native"])
                    self.assertEqual(result["worker"], repo == "pigeon")

    def test_pigeon_backend_only_runs_worker(self):
        for path in ["src/greader.ts", "test/api-auth.test.ts", "test/helpers/browser-app-client-harness.ts", "test/fixtures/email.eml", "migrations/001.sql", "package.json", "package-lock.json"]:
            result = classify("pigeon", [path, "README.md"])
            self.assertFalse(result["native"])
            self.assertTrue(result["worker"])
        self.assertTrue(classify("pigeon", ["src/greader.ts", "ios/PigeonReader/App.swift"])["native"])
        self.assertTrue(classify("pigeon", ["package.json", "ios/PigeonReader/App.swift"])["native"])
        self.assertTrue(classify("pigeon", ["ios/PigeonReader/package.json"])["native"])

    def test_pigeon_browser_extension_runs_worker_only(self):
        for path in ["extension/src/background/index.ts", "extension/package.json", "extension/package-lock.json",
                     "extension/manifests/chromium.json", "extension/static/options.html", "extension/static/icons/icon-16.png",
                     "extension/README.md", "extension/scripts/build.mjs", "extension/test/save.test.ts"]:
            with self.subTest(path=path):
                self.assertEqual(classify("pigeon", [path]), {"native": False, "worker": True, "unknown": []})
        self.assertTrue(classify("pigeon", ["extension/src/a.ts", "ios/PigeonReader/App.swift"])["native"])
        for path in ["extension/../ios/PigeonReader/App.swift", "extensions/a.ts", "ios/extension/a.swift"]:
            with self.subTest(path=path):
                self.assertTrue(classify("pigeon", [path])["native"])
        # Other repositories have no extension; the prefix is not special there.
        self.assertTrue(classify("todomd", ["extension/a.ts"])["native"])

    def test_pigeon_safari_container_runs_worker_and_the_safari_build_but_not_ios(self):
        for path in ["extension/safari/project.yml", "extension/safari/App/PigeonSafariApp.swift",
                     "extension/safari/Extension/Info.plist", "extension/scripts/build-safari.sh"]:
            with self.subTest(path=path):
                self.assertEqual(classify("pigeon", [path]), {"native": False, "worker": True, "unknown": []})
                self.assertTrue(safari_scope("pigeon", [path, "README.md"]))
        for path in [".github/workflows/ci.yml", ".github/scripts/ci_scope.py", "extension/safari/../../ios/a.swift", "/extension/safari/a"]:
            with self.subTest(path=path):
                self.assertTrue(safari_scope("pigeon", [path]))
        for path in ["extension/src/background/index.ts", "extension/manifests/safari.json", "extension/scripts/build.mjs",
                     "ios/PigeonReader/App.swift", "src/greader.ts", "README.md", "extension/safari.md", "extensions/safari/a.swift"]:
            with self.subTest(path=path):
                self.assertFalse(safari_scope("pigeon", [path]))
        self.assertTrue(safari_scope("pigeon", []))
        self.assertTrue(safari_scope("pigeon", ["README.md"], force_full=True))
        for repo in ("todomd", "swole"):
            self.assertFalse(safari_scope(repo, ["extension/safari/project.yml"], force_full=True))

    def test_pigeon_api_contract_fixtures_run_worker_and_native(self):
        for path in ["test/fixtures/api-contract/sync.response.json", "test/fixtures/api-contract/README.md"]:
            with self.subTest(path=path):
                self.assertEqual(classify("pigeon", [path, "src/greader.ts"]), {"native": True, "worker": True, "unknown": []})
                self.assertEqual(classify("pigeon", [path]), {"native": True, "worker": True, "unknown": []})
        self.assertTrue(classify("pigeon", ["test/fixtures/api-contract/../email.eml"])["native"])

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

    def run_scope(self, event_name, payload):
        with tempfile.TemporaryDirectory() as temp:
            event = Path(temp, "event.json")
            event.write_text(payload if isinstance(payload, str) else json.dumps(payload))
            output, summary = Path(temp, "output"), Path(temp, "summary")
            env = {"GITHUB_EVENT_NAME": event_name, "GITHUB_EVENT_PATH": str(event), "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)}
            with patch.dict(os.environ, env):
                scope("pigeon")
            return output.read_text()

    def test_scheduled_or_unreadable_baselines_fail_closed(self):
        for event_name, payload in [("schedule", {}), ("workflow_dispatch", {"inputs": {"ui_suite": "full"}}), ("push", {"before": "0" * 40, "after": "a" * 40}), ("pull_request", {})]:
            output = self.run_scope(event_name, payload)
            self.assertIn("native=true", output)
            self.assertIn("worker=true", output)
            self.assertIn("safari=true", output)

    def test_ui_suite_is_smoke_only_for_pull_requests_pushes_and_explicit_smoke_dispatches(self):
        self.assertEqual(ui_suite("pull_request", {}), "smoke")
        self.assertEqual(ui_suite("push", {}), "smoke")
        self.assertEqual(ui_suite("workflow_dispatch", {"inputs": {"ui_suite": "smoke"}}), "smoke")
        for event_name, event in [("schedule", {}), ("workflow_dispatch", {"inputs": {"ui_suite": "full"}}), ("workflow_dispatch", {}),
                                  ("workflow_dispatch", {"inputs": None}), ("workflow_dispatch", {"inputs": {"ui_suite": "SMOKE"}}), ("merge_group", {}), ("", {})]:
            with self.subTest(event_name=event_name, event=event):
                self.assertEqual(ui_suite(event_name, event), "full")

    def test_scope_writes_ui_suite_and_unreadable_events_run_the_full_suite(self):
        self.assertIn("ui_suite=full", self.run_scope("schedule", {}))
        self.assertIn("ui_suite=smoke", self.run_scope("pull_request", {}))
        self.assertIn("ui_suite=full", self.run_scope("pull_request", "not json"))


class GateTests(unittest.TestCase):
    def needs(self, native="true", worker="true", suite="smoke", safari="true"):
        return {"scope": {"result": "success", "outputs": {"native": native, "worker": worker, "ui_suite": suite, "safari": safari}},
                "tooling": {"result": "success"},
                "native": {"result": "success" if native == "true" else "skipped"},
                "worker": {"result": "success" if worker == "true" else "skipped"},
                "safari": {"result": "success" if safari == "true" else "skipped"}}

    def test_full_docs_and_backend_scopes_accept_only_expected_results(self):
        for native, worker in [("true", "true"), ("false", "false"), ("false", "true")]:
            for repo in ("pigeon", "todomd", "swole"):
                for safari in ("true", "false"):
                    self.assertEqual(validate_gate(repo, self.needs(native, worker, safari=safari)), [])

    def test_failures_cancellations_and_unexpected_skips_do_not_pass(self):
        for job in ("scope", "tooling", "native", "worker", "safari"):
            for status in ("failure", "cancelled", "skipped", None):
                needs = self.needs()
                needs[job]["result"] = status
                self.assertTrue(validate_gate("pigeon", needs), (job, status))

    def test_scope_output_missing_invalid_or_empty_does_not_pass(self):
        for value in (None, "", "yes", True):
            for job in ("native", "safari"):
                needs = self.needs()
                needs["scope"]["outputs"][job] = value
                self.assertTrue(validate_gate("pigeon", needs))
        needs = self.needs()
        del needs["scope"]["outputs"]["safari"]
        self.assertTrue(validate_gate("pigeon", needs))
        self.assertEqual(validate_gate("todomd", needs), [])
        for job in self.needs():
            needs = self.needs()
            del needs[job]
            self.assertTrue(validate_gate("pigeon", needs))

    def test_ui_suite_output_must_be_full_or_smoke(self):
        for suite in ("full", "smoke"):
            self.assertEqual(validate_gate("pigeon", self.needs(suite=suite)), [])
        for suite in (None, "", "all", "Full"):
            self.assertTrue(validate_gate("pigeon", self.needs(suite=suite)), suite)
        needs = self.needs()
        del needs["scope"]["outputs"]["ui_suite"]
        self.assertTrue(validate_gate("pigeon", needs))
        self.assertEqual(validate_gate("todomd", needs), [])

    def test_intentional_skips_cannot_mask_failed_suites(self):
        for job in ("native", "worker", "safari"):
            for status in ("failure", "cancelled", "success"):
                needs = self.needs("false", "false", safari="false")
                needs[job]["result"] = status
                self.assertTrue(validate_gate("pigeon", needs))


if __name__ == "__main__":
    unittest.main()
