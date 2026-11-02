#!/usr/bin/env bash
# Runs `xcodebuild test` with the given arguments. If the only failure is the
# UI test runner failing to start ("Timed out waiting for AX loaded
# notification"), reruns the UI tests once with test-without-building.
#
# That error comes from the simulator's accessibility service, not from a test:
# every unit test has already passed and no UI test has run. It recurs on the
# shared Mac even after the boot wait in ios-simulator-session.py, and a second
# start of the runner succeeds. Any real test failure is never retried.
#
# Usage: run-ios-tests.sh <log file> <xcodebuild arguments...>
# Env:   TEST_RESULT_BUNDLE  optional result bundle path for the first run
#        XCODEBUILD          xcodebuild binary (fixtures replace it)
#        UI_TEST_TARGET      UI test target to rerun (default PigeonReaderUITests)
set -uo pipefail

log="$1"
shift
xcodebuild_bin="${XCODEBUILD:-xcodebuild}"
ui_target="${UI_TEST_TARGET:-PigeonReaderUITests}"
runner_start_failure="failed to initialize for UI testing"

bundle_args=()
if [[ -n "${TEST_RESULT_BUNDLE:-}" ]]; then
  bundle_args=(-resultBundlePath "$TEST_RESULT_BUNDLE")
fi
"$xcodebuild_bin" test "$@" ${bundle_args[@]+"${bundle_args[@]}"} 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"
[[ "$status" -eq 0 ]] && exit 0

if ! grep -q "$runner_start_failure" "$log"; then
  exit "$status"
fi
if grep -qE "✘ Test |Test Case '.*' failed" "$log"; then
  echo "::error::The UI test runner failed to start, and tests also failed; not retrying." >&2
  exit "$status"
fi

echo "::warning::The UI test runner failed to start ($runner_start_failure); rerunning $ui_target once." >&2
retry_bundle_args=()
if [[ -n "${TEST_RESULT_BUNDLE:-}" ]]; then
  retry_bundle_args=(-resultBundlePath "${TEST_RESULT_BUNDLE%.xcresult}-ui-retry.xcresult")
fi
"$xcodebuild_bin" test-without-building "$@" -only-testing:"$ui_target" \
  ${retry_bundle_args[@]+"${retry_bundle_args[@]}"} 2>&1 | tee -a "$log"
exit "${PIPESTATUS[0]}"
