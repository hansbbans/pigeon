#!/usr/bin/env bash
# Fixture tests for run-ios-tests.sh with a fake xcodebuild.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" >/dev/null && pwd -P)"
SCRIPT="$SCRIPT_DIR/run-ios-tests.sh"
TEST_ROOT="$(mktemp -d /tmp/pigeon-run-ios-tests.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT

# The fake reads its outcome for each call from $TEST_ROOT/outcomes (one line
# per call: "ok", "ax", "ax-and-failure", "failure") and records its arguments.
FAKE="$TEST_ROOT/xcodebuild"
cat > "$FAKE" <<'FAKE_EOF'
#!/usr/bin/env bash
root="$(dirname "$0")"
echo "$*" >> "$root/calls"
count=$(wc -l < "$root/calls" | tr -d ' ')
outcome=$(sed -n "${count}p" "$root/outcomes")
case "$outcome" in
  ok) echo "** TEST SUCCEEDED **"; exit 0 ;;
  ax) echo "✔ Test run with 812 tests in 63 suites passed"
      echo "PigeonReaderUITests-Runner (1) encountered an error (The test runner failed to initialize for UI testing. (Underlying Error: Timed out waiting for AX loaded notification))"
      echo "** TEST FAILED **"; exit 65 ;;
  ax-and-failure) echo "✘ Test syncWorks() recorded an issue"
      echo "PigeonReaderUITests-Runner (1) encountered an error (The test runner failed to initialize for UI testing.)"
      echo "** TEST FAILED **"; exit 65 ;;
  ax-and-crash) echo "PigeonReader (2) encountered an error (Early unexpected exit, operation never finished bootstrapping)"
      echo "PigeonReaderUITests-Runner (1) encountered an error (The test runner failed to initialize for UI testing.)"
      echo "** TEST FAILED **"; exit 65 ;;
  failure) echo "Test Case '-[PigeonReaderUITests.PigeonReaderUITests testX]' failed (1.0 seconds)."
      echo "** TEST FAILED **"; exit 65 ;;
esac
FAKE_EOF
chmod +x "$FAKE"

run_case() {
  local name="$1" outcomes="$2" expected_status="$3" expected_calls="$4"
  rm -f "$TEST_ROOT/calls"
  printf '%s\n' $outcomes > "$TEST_ROOT/outcomes"
  set +e
  XCODEBUILD="$FAKE" TEST_RESULT_BUNDLE="$TEST_ROOT/Result.xcresult" \
    bash "$SCRIPT" "$TEST_ROOT/log" -scheme PigeonReader -derivedDataPath /tmp/dd >/dev/null 2>"$TEST_ROOT/stderr"
  local status=$?
  set -e
  local calls
  calls=$(wc -l < "$TEST_ROOT/calls" | tr -d ' ')
  if [[ "$status" -ne "$expected_status" || "$calls" -ne "$expected_calls" ]]; then
    echo "FAIL $name: status $status (want $expected_status), calls $calls (want $expected_calls)"
    cat "$TEST_ROOT/calls" "$TEST_ROOT/stderr"
    exit 1
  fi
  echo "ok $name"
}

run_case "passing run is not retried" "ok" 0 1
run_case "real test failure is not retried" "failure" 65 1
run_case "runner start failure with a test failure is not retried" "ax-and-failure" 65 1
run_case "runner start failure with a crashed test host is not retried" "ax-and-crash" 65 1
run_case "runner start failure retries UI tests and passes" "ax ok" 0 2
run_case "runner start failure retried once only" "ax ax" 65 2

# The retry reruns only the UI target, without rebuilding, into its own bundle.
rm -f "$TEST_ROOT/calls"; printf '%s\n' ax ok > "$TEST_ROOT/outcomes"
XCODEBUILD="$FAKE" TEST_RESULT_BUNDLE="$TEST_ROOT/Result.xcresult" \
  bash "$SCRIPT" "$TEST_ROOT/log" -scheme PigeonReader >/dev/null 2>&1
retry=$(sed -n 2p "$TEST_ROOT/calls")
[[ "$retry" == "test-without-building -scheme PigeonReader -only-testing:PigeonReaderUITests -resultBundlePath $TEST_ROOT/Result-ui-retry.xcresult" ]] \
  || { echo "FAIL retry arguments: $retry"; exit 1; }
grep -q "AX loaded" "$TEST_ROOT/log" && grep -q "TEST SUCCEEDED" "$TEST_ROOT/log" \
  || { echo "FAIL log keeps both runs"; exit 1; }
echo "ok retry arguments and combined log"
