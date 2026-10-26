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
  actual="$(cat "$LOCK/owner" 2>/dev/null || echo '<none>')"
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

if run_lock third frobnicate 2>/dev/null; then
  fail_test "unknown action was accepted"
fi

echo "ios_runner_lock test: PASS"
