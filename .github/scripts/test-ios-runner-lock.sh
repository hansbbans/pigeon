#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" >/dev/null && pwd -P)"
SCRIPT="$SCRIPT_DIR/ios-runner-lock.sh"
TEST_ROOT="$(mktemp -d /tmp/pigeon-runner-lock-test.XXXXXX)"
LOCK="$TEST_ROOT/lock"
trap 'chmod -R u+w "$TEST_ROOT" 2>/dev/null; rm -rf "$TEST_ROOT"' EXIT

fail_test() {
  echo "$1" >&2
  exit 1
}

run_lock() {
  local owner="$1"
  shift
  IOS_RUNNER_LOCK_DIR="$LOCK" IOS_RUNNER_LOCK_OWNER="$owner" IOS_RUNNER_LOCK_POLL_SECONDS=1 \
    IOS_RUNNER_LOCK_SETTLE_SECONDS="${IOS_RUNNER_LOCK_SETTLE_SECONDS:-0}" bash "$SCRIPT" "$@"
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

# An abandoned lock that cannot be renamed away is waited on, then given up
# on, rather than retried in a tight loop.
mkdir -p "$TEST_ROOT/ro/lock"
printf '%s\n%s\n' 'vanished' "$dead_pid" > "$TEST_ROOT/ro/lock/owner"
chmod 555 "$TEST_ROOT/ro"
if output="$(IOS_RUNNER_LOCK_DIR="$TEST_ROOT/ro/lock" IOS_RUNNER_LOCK_OWNER=ninth IOS_RUNNER_LOCK_POLL_SECONDS=1 \
    IOS_RUNNER_LOCK_WAIT_SECONDS=2 IOS_RUNNER_LOCK_SETTLE_SECONDS=0 bash "$SCRIPT" acquire 2>&1)"; then
  chmod 755 "$TEST_ROOT/ro"
  fail_test "took an abandoned lock it could not rename away"
fi
chmod 755 "$TEST_ROOT/ro"
grep -q "Gave up" <<<"$output" || fail_test "an unrenamable abandoned lock did not reach the wait cap: $output"

# A lock renamed away by a racing waiter right after acquisition is noticed
# during the settle period instead of being treated as held.
( if IOS_RUNNER_LOCK_SETTLE_SECONDS=3 IOS_RUNNER_LOCK_WAIT_SECONDS=2 run_lock tenth acquire > "$TEST_ROOT/tenth.log" 2>&1; then
    echo 0 > "$TEST_ROOT/tenth.status"
  else
    echo $? > "$TEST_ROOT/tenth.status"
  fi ) &
sleep 1
printf '%s\n%s\n' 'thief' "$$" > "$LOCK/owner"
wait
[[ "$(cat "$TEST_ROOT/tenth.status")" != 0 ]] || fail_test "acquire reported success after its lock was taken over: $(cat "$TEST_ROOT/tenth.log")"
grep -q "taken over" "$TEST_ROOT/tenth.log" || fail_test "the takeover was not noticed: $(cat "$TEST_ROOT/tenth.log")"
assert_owner thief
rm -rf "$LOCK"
[[ -f "$TEST_ROOT/tenth.status" ]] || fail_test "the takeover test did not record an exit status"

# A lock renamed away during the settle period and then put back by the racing
# waiter still belongs to this job; acquire notices instead of waiting on itself.
( if IOS_RUNNER_LOCK_SETTLE_SECONDS=2 IOS_RUNNER_LOCK_WAIT_SECONDS=10 run_lock twelfth acquire > "$TEST_ROOT/twelfth.log" 2>&1; then
    echo 0 > "$TEST_ROOT/twelfth.status"
  else
    echo $? > "$TEST_ROOT/twelfth.status"
  fi ) &
sleep 1
saved_owner="$(cat "$LOCK/owner")"
printf '%s\n%s\n' 'thief' "$$" > "$LOCK/owner"
sleep 2
printf '%s\n' "$saved_owner" > "$LOCK/owner"
wait
[[ "$(cat "$TEST_ROOT/twelfth.status")" == 0 ]] || fail_test "acquire did not recognise its own restored lock: $(cat "$TEST_ROOT/twelfth.log")"
grep -q "restored after a racing rename" "$TEST_ROOT/twelfth.log" || fail_test "the restored lock was not reported: $(cat "$TEST_ROOT/twelfth.log")"
assert_owner twelfth
run_lock twelfth release
[[ ! -d "$LOCK" ]] || fail_test "the restored lock could not be released"

# A waiter that judged the old lock abandoned must not steal a lock another
# job acquired in the meantime: the renamed directory is put back untouched.
mkdir "$LOCK"
printf '%s\n%s\n' 'fresh-holder' "$$" > "$LOCK/owner"
if IOS_RUNNER_LOCK_WAIT_SECONDS=2 run_lock eleventh acquire; then
  fail_test "a lock with a live holder was stolen"
fi
assert_owner fresh-holder
rm -rf "$LOCK"

# Outside Actions, acquire and release run in separate shells with no explicit owner.
IOS_RUNNER_LOCK_DIR="$LOCK" IOS_RUNNER_LOCK_POLL_SECONDS=1 bash "$SCRIPT" acquire
IOS_RUNNER_LOCK_DIR="$LOCK" IOS_RUNNER_LOCK_POLL_SECONDS=1 bash "$SCRIPT" release
[[ ! -d "$LOCK" ]] || fail_test "the default local owner could not release its own lock"

if run_lock third frobnicate 2>/dev/null; then
  fail_test "unknown action was accepted"
fi

echo "ios_runner_lock test: PASS"
