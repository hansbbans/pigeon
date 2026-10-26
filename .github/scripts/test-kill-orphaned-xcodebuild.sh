#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" >/dev/null && pwd -P)"
SCRIPT="$SCRIPT_DIR/kill-orphaned-xcodebuild.sh"
TEST_ROOT="$(mktemp -d /tmp/pigeon-orphan-test.XXXXXX)"
PROCESS_LIST="$TEST_ROOT/processes.txt"
DUMMY_PIDS=()
cleanup() {
  if (( ${#DUMMY_PIDS[@]} )); then
    kill "${DUMMY_PIDS[@]}" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

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
106 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project TodoMD.xcodeproj -scheme TodoMDApp -configuration Release -archivePath /Users/ci/actions-runner-todomd/_work/todomd/todomd/build/TodoMDApp.xcarchive archive
107 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -exportArchive -archivePath /Users/ci/actions-runner-pigeon/_work/pigeon/pigeon/.release/pigeon-testflight-1-1/PigeonReader.xcarchive
108 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test -derivedDataPath /Users/ci/actions-runner-todomd/_work/_temp/todomd-ci/1222-1/derived-data
109 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test -derivedDataPath /Users/ci/actions-runner-todomd/_work/_temp/todomd-ci/222-10/derived-data
110 /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test -derivedDataPath /Users/ci/actions-runner-todomd/_work/_temp/pigeon-ci-222-1 -resultBundlePath /Users/ci/actions-runner-todomd/_work/_temp/PigeonReaderTests-222-1.xcresult
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
grep -q "(pid 106)" <<<"$output" || fail_test "an earlier release archive under the workspace was not reported: $output"
grep -q "(pid 107)" <<<"$output" && fail_test "another runner's release archive was reported"
grep -q "(pid 108)" <<<"$output" || fail_test "run 1222-1 was mistaken for the current run 222-1: $output"
grep -q "(pid 109)" <<<"$output" || fail_test "run 222-10 was mistaken for the current run 222-1: $output"
grep -q "(pid 110)" <<<"$output" && fail_test "the current run's suffix-style paths were reported"
grep -q "handled: 5" <<<"$output" || fail_test "expected five orphans, got: $output"

# At the end of a job the current run's own leftovers are fair game too.
output="$(
  RUNNER_TEMP=/Users/ci/actions-runner-todomd/_work/_temp \
  GITHUB_RUN_ID=222 GITHUB_RUN_ATTEMPT=1 \
  ORPHAN_INCLUDE_CURRENT_RUN=1 \
  ORPHAN_PROCESS_LIST="$PROCESS_LIST" \
  bash "$SCRIPT"
)"
grep -q "(pid 101)" <<<"$output" || fail_test "the current run's xcodebuild was spared at job end: $output"
grep -q "(pid 110)" <<<"$output" || fail_test "the current run's xctest paths were spared at job end: $output"
grep -q "(pid 102)" <<<"$output" && fail_test "another runner's xcodebuild was reported at job end"
grep -q "handled: 7" <<<"$output" || fail_test "expected seven processes at job end, got: $output"

# GitHub Actions sets GITHUB_RUN_ID for every step, so drop it explicitly.
if env -u GITHUB_RUN_ID -u GITHUB_RUN_ATTEMPT RUNNER_TEMP=/Users/ci/actions-runner-todomd/_work/_temp ORPHAN_PROCESS_LIST="$PROCESS_LIST" bash "$SCRIPT" 2>/dev/null; then
  fail_test "missing GITHUB_RUN_ID was accepted"
fi

# A RUNNER_TEMP whose parent is not a runner work directory would scope the
# kill to the whole machine.
if RUNNER_TEMP=/tmp GITHUB_RUN_ID=222 ORPHAN_PROCESS_LIST="$PROCESS_LIST" bash "$SCRIPT" 2>/dev/null; then
  fail_test "a RUNNER_TEMP outside a _work directory was accepted"
fi

# The real kill path: a process whose command line names the work directory
# and "xcodebuild" is terminated; the current run's process survives until
# the job-end pass.
work_root="$TEST_ROOT/_work"
mkdir -p "$work_root/_temp/todomd-ci/999-1"
bash -c 'exec -a "$0" sleep 300' "$work_root/xcodebuild" &
orphan_pid=$!
bash -c 'exec -a "$0" sleep 300' "$work_root/_temp/todomd-ci/999-1/xcodebuild" &
current_pid=$!
DUMMY_PIDS=("$orphan_pid" "$current_pid")
# Drop the jobs from job control so bash does not report their termination.
disown -a
sleep 1

wait_for_exit() {
  local attempt
  for attempt in $(seq 1 40); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.25
  done
  return 1
}

output="$(RUNNER_TEMP="$work_root/_temp" GITHUB_RUN_ID=999 GITHUB_RUN_ATTEMPT=1 ORPHAN_KILL_GRACE_SECONDS=1 bash "$SCRIPT")"
grep -q "(pid $orphan_pid)" <<<"$output" || fail_test "the dummy orphan was not reported: $output"
wait_for_exit "$orphan_pid" || fail_test "the dummy orphan survived"
kill -0 "$current_pid" 2>/dev/null || fail_test "the current run's dummy process was killed before job end"

output="$(RUNNER_TEMP="$work_root/_temp" GITHUB_RUN_ID=999 GITHUB_RUN_ATTEMPT=1 ORPHAN_INCLUDE_CURRENT_RUN=1 ORPHAN_KILL_GRACE_SECONDS=1 bash "$SCRIPT")"
grep -q "(pid $current_pid)" <<<"$output" || fail_test "the current run's dummy process was not reported at job end: $output"
wait_for_exit "$current_pid" || fail_test "the current run's dummy process survived job end"
DUMMY_PIDS=()

echo "kill_orphaned_xcodebuild test: PASS"
