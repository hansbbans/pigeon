#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" >/dev/null && pwd -P)"
SCRIPT="$SCRIPT_DIR/ios-runner-lock.sh"
TEST_ROOT="$(mktemp -d /tmp/pigeon-runner-lock-test.XXXXXX)"
LOCK="$TEST_ROOT/lock"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail_test() {
  echo "$1" >&2
  exit 1
}

run_lock() {
  local owner="$1"
  shift
  IOS_RUNNER_LOCK_DIR="$LOCK" IOS_RUNNER_LOCK_OWNER="$owner" IOS_RUNNER_LOCK_POLL_SECONDS=1 bash "$SCRIPT" "$@"
}

assert_owner() {
  local actual
  # The owner file holds the owner on line 1 and the holder's job pid on line 2.
  actual="$(sed -n '1p' "$LOCK/owner" 2>/dev/null || true)"
  [[ -n "$actual" ]] || actual='<none>'
  [[ "$actual" == "$1" ]] || fail_test "expected lock owner $1, found $actual"
}

run_lock first acquire
assert_owner first

if IOS_RUNNER_LOCK_WAIT_SECONDS=2 run_lock second acquire; then
  fail_test "a second owner acquired a held lock"
fi
assert_owner first

run_lock second release
[[ -d "$LOCK" ]] || fail_test "a non-owner released the lock"
assert_owner first

run_lock first release
[[ ! -d "$LOCK" ]] || fail_test "the owner could not release the lock"

run_lock first acquire
( sleep 2; run_lock first release ) &
IOS_RUNNER_LOCK_WAIT_SECONDS=30 run_lock second acquire
wait
assert_owner second
run_lock second release

mkdir "$LOCK"
printf '%s\n' 'vanished' > "$LOCK/owner"
touch -t 202001010000 "$LOCK"
IOS_RUNNER_LOCK_WAIT_SECONDS=5 run_lock third acquire
assert_owner third
run_lock third release

run_lock third release
[[ ! -d "$LOCK" ]] || fail_test "release recreated the lock"

mkdir "$LOCK"
if IOS_RUNNER_LOCK_WAIT_SECONDS=2 run_lock fourth acquire; then
  fail_test "a fresh ownerless lock (another job mid-acquire) was replaced"
fi
touch -t 202001010000 "$LOCK"
IOS_RUNNER_LOCK_WAIT_SECONDS=5 run_lock fourth acquire
assert_owner fourth
run_lock fourth release

# A lock whose holder process is gone is replaced immediately, before any age rule.
sleep 0.1 &
dead_pid=$!
wait "$dead_pid"
mkdir "$LOCK"
printf '%s\n%s\n' 'crashed-job' "$dead_pid" > "$LOCK/owner"
IOS_RUNNER_LOCK_WAIT_SECONDS=5 run_lock fifth acquire
assert_owner fifth
run_lock fifth release

# A lock whose holder process is alive is honored even without an explicit owner match.
mkdir "$LOCK"
printf '%s\n%s\n' 'running-job' "$$" > "$LOCK/owner"
if IOS_RUNNER_LOCK_WAIT_SECONDS=2 run_lock sixth acquire; then
  fail_test "a lock with a live holder process was replaced"
fi
assert_owner running-job
rm -rf "$LOCK"

# The acquired lock records a live job pid on its second line.
run_lock seventh acquire
recorded_pid="$(sed -n '2p' "$LOCK/owner")"
[[ "$recorded_pid" =~ ^[0-9]+$ ]] || fail_test "no job pid recorded: $(cat "$LOCK/owner")"
ps -p "$recorded_pid" >/dev/null || fail_test "recorded job pid $recorded_pid is not alive"
run_lock seventh release

# A waiter whose step shell has died stops waiting instead of taking the lock later.
run_lock first acquire
if IOS_RUNNER_LOCK_PARENT_PID="$dead_pid" IOS_RUNNER_LOCK_WAIT_SECONDS=30 run_lock eighth acquire 2>/dev/null; then
  fail_test "an orphaned waiter took the lock"
fi
assert_owner first
run_lock first release

# Outside Actions, acquire and release run in separate shells with no explicit owner.
IOS_RUNNER_LOCK_DIR="$LOCK" IOS_RUNNER_LOCK_POLL_SECONDS=1 bash "$SCRIPT" acquire
IOS_RUNNER_LOCK_DIR="$LOCK" IOS_RUNNER_LOCK_POLL_SECONDS=1 bash "$SCRIPT" release
[[ ! -d "$LOCK" ]] || fail_test "the default local owner could not release its own lock"

if run_lock third frobnicate 2>/dev/null; then
  fail_test "unknown action was accepted"
fi

echo "ios_runner_lock test: PASS"
