#!/usr/bin/env python3
"""Conservative CI scope and the always-reported required validation gate."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import subprocess

RELEASE_TOOLING = {
    "pigeon": {
        "scripts/app-store-connect-verify.mjs", "scripts/release-new-build-to-testflight.mjs",
        "scripts/require-testflight-commit.sh", "scripts/testflight-ci-gate.mjs",
        "test/app-store-connect-verify.test.mjs", "test/testflight-ci-gate.test.mjs",
        "test/testflight-release-monitor.test.mjs",
    },
    "todomd": {
        "scripts/release_new_build_to_testflight.sh", "scripts/testflight_monitor.rb",
        "scripts/tests/testflight_monitor_test.rb", "Tools/assign_testflight_groups.rb",
        "Tools/test_assign_testflight_groups.rb", "Tests/Tools/AssignTestFlightGroupsTests.rb",
        "Tests/Tools/TestFlightDispatchPayloadTests.rb",
    },
    "swole": {
        "scripts/release_new_build_to_testflight.sh", "scripts/release_testflight.sh",
        "scripts/ship_to_testflight_github.sh", "scripts/testflight_monitor.rb",
        "scripts/tests/testflight_monitor_test.rb", "scripts/test_release_testflight.sh",
        "scripts/test_release_testflight_mock_curl.sh", "scripts/test_release_testflight_mock_ruby.sh",
    },
}
ROOT_DOCS = {
    "README.md", "AGENTS.md", "CHANGELOG.md", "ROADMAP.md", "TODOS.md",
    "todo-md-spec.md", "perspectives-user-stories.md",
}
PIGEON_DOC_DIRS = {
    "00-master-plan", "01-architecture", "02-email-ingestion", "03-parsing-engine",
    "04-storage", "05-rss-serving", "06-feed-management", "07-custom-parsing-rules", "08-testing",
}


def classify(repo, paths, force_full=False):
    if repo not in RELEASE_TOOLING:
        raise ValueError("Unsupported repository")
    native = force_full or not paths
    worker = native and repo == "pigeon"
    unknown = []
    for path in paths:
        parts = PurePosixPath(path).parts
        valid = parts and not path.startswith("/") and ".." not in parts
        doc_dir = valid and (parts[0] == "docs" or (repo == "pigeon" and parts[0] in PIGEON_DOC_DIRS))
        docs = valid and path.endswith(".md") and (path in ROOT_DOCS or doc_dir or path in {"SwoleMCP/README.md", "scripts/testflight-monitor.md"})
        if docs or path in RELEASE_TOOLING[repo]:
            continue
        # These backend inputs cannot change the native app. Dependencies and
        # configuration are deliberately outside this narrow allowlist.
        backend = valid and repo == "pigeon" and (
            (path.startswith("src/") and path.endswith(".ts")) or
            (path.startswith("test/") and (path.endswith(".ts") or path.startswith("test/fixtures/"))) or
            (path.startswith("migrations/") and path.endswith(".sql"))
        )
        if backend:
            worker = True
        else:
            native = True
            worker = repo == "pigeon"
            unknown.append(path)
    return {"native": native, "worker": worker, "unknown": unknown}


def changed_paths(event_name, event):
    if event_name == "pull_request":
        base = event["pull_request"]["base"]["sha"]
        head = event["pull_request"]["head"]["sha"]
        revisions = f"{base}...{head}"
    elif event_name == "push":
        base, head = event["before"], event["after"]
        if base == "0" * 40:
            raise ValueError("Initial push has no trustworthy baseline")
        revisions = f"{base}..{head}"
    else:
        raise ValueError("Scheduled/manual CI requires full validation")
    # No rename detection: both deleted and added paths participate in scope.
    payload = subprocess.check_output(["git", "diff", "--name-only", "--no-renames", "-z", revisions, "--"])
    return [p.decode("utf-8") for p in payload.split(b"\0") if p]


def scope(repo):
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        paths = changed_paths(os.environ["GITHUB_EVENT_NAME"], event)
        result = classify(repo, paths)
        reason = "Changed paths classified conservatively."
    except (KeyError, ValueError, OSError, subprocess.CalledProcessError) as error:
        result = classify(repo, [], force_full=True)
        paths = []
        reason = f"Full validation: baseline unavailable ({type(error).__name__})."
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"native={str(result['native']).lower()}\nworker={str(result['worker']).lower()}\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write("### CI validation scope\n\n" + reason + "\n\n")
        summary.write(f"Native validation: **{result['native']}**. Worker validation: **{result['worker']}**.\n\n")
        # JSON keeps newlines/control characters in filenames out of Markdown.
        summary.write("Changed paths: `" + json.dumps(paths).replace("`", "\\u0060") + "`\n")
    print(json.dumps(result))


def validate_gate(repo, needs):
    errors = []
    for job in ("scope", "tooling"):
        if needs.get(job, {}).get("result") != "success":
            errors.append(f"{job} must succeed")
    outputs = needs.get("scope", {}).get("outputs", {})
    for job in (["native", "worker"] if repo == "pigeon" else ["native"]):
        required = outputs.get(job)
        result = needs.get(job, {}).get("result")
        if required not in ("true", "false"):
            errors.append(f"Missing/invalid {job} classification")
        elif result != ("success" if required == "true" else "skipped"):
            errors.append(f"{job}: expected {'success' if required == 'true' else 'intentional skip'}, received {result}")
    return errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["scope", "gate"])
    parser.add_argument("--repo", required=True, choices=sorted(RELEASE_TOOLING))
    args = parser.parse_args()
    if args.mode == "scope":
        scope(args.repo)
    else:
        errors = validate_gate(args.repo, json.loads(os.environ["NEEDS_JSON"]))
        for error in errors:
            print("::error::" + error)
        if errors:
            raise SystemExit(1)
        print("All required validation passed; excluded suites were intentionally skipped.")


if __name__ == "__main__":
    main()
