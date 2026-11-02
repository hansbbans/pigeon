#!/usr/bin/env python3
"""Smoke UI test list: validate entries, emit -only-testing flags, verify the run.

PR and push CI run every PigeonReaderTests unit test plus the UI tests listed
in .github/ios-smoke-ui-tests.txt. xcodebuild silently runs nothing for an
-only-testing identifier that no longer exists, so a stale entry must fail CI:
`check` proves every entry names a real test method before the run, and
`verify-log` proves xcodebuild reported every entry as run afterwards.
"""
import argparse
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LIST = ROOT / ".github" / "ios-smoke-ui-tests.txt"
DEFAULT_TESTS_DIR = ROOT / "ios" / "PigeonReader" / "PigeonReaderUITests"
UI_TEST_TARGET = "PigeonReaderUITests"
UNIT_TEST_TARGET = "PigeonReaderTests"

ENTRY = re.compile(r"^(\w+)/(\w+)/(test\w+)$")
# A type or extension declared at column 0 opens a region that runs until the
# next column-0 declaration. Test methods are indented inside that region.
TOP_LEVEL = re.compile(
    r"^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:final|public|internal|private|fileprivate|open)\s+)*"
    r"(class|struct|enum|extension|actor|protocol|func|let|var)\b\s*(\w+)?"
)
TEST_METHOD = re.compile(r"^\s+(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:override|final|public|internal|open)\s+)*func\s+(test\w+)\s*\(")


def read_entries(list_path):
    entries, errors, seen = [], [], set()
    for number, raw in enumerate(Path(list_path).read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = ENTRY.match(line)
        if not match:
            errors.append(f"{list_path}:{number}: expected {UI_TEST_TARGET}/Class/testMethod, got {line!r}")
        elif match.group(1) != UI_TEST_TARGET:
            errors.append(f"{list_path}:{number}: smoke entries must be in {UI_TEST_TARGET}, got {line!r}")
        elif line in seen:
            errors.append(f"{list_path}:{number}: duplicate entry {line}")
        else:
            seen.add(line)
            entries.append(line)
    if not entries and not errors:
        errors.append(f"{list_path}: lists no smoke UI tests")
    return entries, errors


def discover_tests(tests_dir):
    """Map class name -> set of test method names declared in its body or extensions."""
    tests = {}
    files = sorted(Path(tests_dir).glob("*.swift"))
    if not files:
        raise FileNotFoundError(f"No Swift files in {tests_dir}")
    for path in files:
        owner = None
        for line in path.read_text().splitlines():
            top = TOP_LEVEL.match(line)
            if top:
                owner = top.group(2) if top.group(1) in ("class", "extension") else None
                if owner:
                    tests.setdefault(owner, set())
                continue
            method = TEST_METHOD.match(line)
            if owner and method:
                tests[owner].add(method.group(1))
    return tests


def check(list_path, tests_dir):
    entries, errors = read_entries(list_path)
    tests = discover_tests(tests_dir)
    for entry in entries:
        _, cls, method = entry.split("/")
        if cls not in tests:
            errors.append(f"Stale smoke entry {entry}: no class {cls} in {tests_dir}")
        elif method not in tests[cls]:
            errors.append(f"Stale smoke entry {entry}: {cls} has no method {method}")
    return entries, errors


def verify_log(list_path, log_path):
    entries, errors = read_entries(list_path)
    log = Path(log_path).read_text(errors="replace")
    # XCTest reports each case as: Test Case '-[Target.Class method]' passed (1.2 seconds).
    # Only "passed" counts: a smoke test that skips itself (XCTSkip on an
    # unexpected simulator size) proved nothing.
    ran = set(re.findall(r"Test Case '-\[(\w+)\.(\w+) (test\w+)\]' passed", log))
    for entry in entries:
        if tuple(entry.split("/")) not in ran:
            errors.append(f"xcodebuild did not report smoke UI test {entry} as passed")
    # The unit tests use Swift Testing, which ends with one summary line:
    # "Test run with 812 tests in 63 suites passed after 38.2 seconds."
    # Require it with a nonzero count so a renamed target can't run zero tests.
    unit_counts = [int(n) for n in re.findall(r"Test run with (\d+) tests?\b[^\n]* passed after", log)]
    if not any(unit_counts):
        errors.append(f"xcodebuild did not report a passing {UNIT_TEST_TARGET} run with at least one test")
    ui_ran = {case for case in ran if case[0] == UI_TEST_TARGET}
    return entries, ui_ran, errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=["check", "args", "verify-log"])
    parser.add_argument("log", nargs="?", help="xcodebuild test log (verify-log only)")
    parser.add_argument("--list", default=str(DEFAULT_LIST))
    parser.add_argument("--tests-dir", default=str(DEFAULT_TESTS_DIR))
    args = parser.parse_args(argv)
    if args.mode == "verify-log":
        if not args.log:
            parser.error("verify-log needs the xcodebuild log path")
        entries, ui_ran, errors = verify_log(args.list, args.log)
    else:
        entries, errors = check(args.list, args.tests_dir)
    for error in errors:
        print(f"::error::{error}", file=sys.stderr)
    if errors:
        return 1
    if args.mode == "args":
        print(f"-only-testing:{UNIT_TEST_TARGET}")
        for entry in entries:
            print(f"-only-testing:{entry}")
    elif args.mode == "check":
        print(f"All {len(entries)} smoke UI tests exist.", file=sys.stderr)
    else:
        print(f"xcodebuild ran all {len(entries)} listed smoke UI tests ({len(ui_ran)} UI tests reported).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
