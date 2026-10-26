#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" >/dev/null && pwd -P)"
SCRIPT="$SCRIPT_DIR/kill-orphaned-xcodebuild.sh"
TEST_ROOT="$(mktemp -d /tmp/pigeon-orphan-test.XXXXXX)"
PROCESS_LIST="$TEST_ROOT/processes.txt"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail_test() {
  echo "$1" >&2
  exit 1
}

cat > "$PROCESS_LIST" <<'LIST'
100 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test -derivedDataPath /Users/ci/actions-runner-todomd/_work/_temp/todomd-ci/111-1/derived-data
101 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test -derivedDataPath /Users/ci/actions-runner-todomd/_work/_temp/todomd-ci/222-1/derived-data
102 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test -derivedDataPath /Users/ci/actions-runner-pigeon/_work/_temp/pigeon-ci-333-1
103 /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator
104 /Users/ci/actions-runner-todomd/_work/_temp/todomd-ci/111-1/derived-data/Build/Products/Debug-iphonesimulator/TodoMDAppUITests-Runner.app/PlugIns/TodoMDAppUITests.xctest/TodoMDAppUITests
105 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test -derivedDataPath /Users/hans/Library/Developer/Xcode/DerivedData/TodoMD-abc
not-a-pid xcodebuild /Users/ci/actions-runner-todomd/_work/_temp/todomd-ci/111-1
LIST

output="$(
  RUNNER_TEMP=/Users/ci/actions-runner-todomd/_work/_temp \
  GITHUB_RUN_ID=222 GITHUB_RUN_ATTEMPT=1 \
  ORPHAN_PROCESS_LIST="$PROCESS_LIST" \
  bash "$SCRIPT"
)"

grep -q "(pid 100)" <<<"$output" || fail_test "earlier run's xcodebuild was not reported: $output"
grep -q "(pid 104)" <<<"$output" || fail_test "earlier run's xctest was not reported: $output"
grep -q "(pid 101)" <<<"$output" && fail_test "the current run's xcodebuild was reported"
grep -q "(pid 102)" <<<"$output" && fail_test "another runner's xcodebuild was reported"
grep -q "(pid 103)" <<<"$output" && fail_test "a manual Simulator session was reported"
grep -q "(pid 105)" <<<"$output" && fail_test "a local developer build was reported"
grep -q "handled: 2" <<<"$output" || fail_test "expected two orphans, got: $output"

if RUNNER_TEMP=/tmp ORPHAN_PROCESS_LIST="$PROCESS_LIST" bash "$SCRIPT" 2>/dev/null; then
  fail_test "missing GITHUB_RUN_ID was accepted"
fi

echo "kill_orphaned_xcodebuild test: PASS"
