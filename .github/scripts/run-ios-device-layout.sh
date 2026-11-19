#!/bin/bash
# Runs the device layout walk on each requested simulator family, one after
# the other, and collects screenshots, layout dumps and logs.
#
#   run-ios-device-layout.sh "<name prefix>,<name prefix>,..." layout|smoke|full [unit]
#
#   layout: PigeonDeviceLayoutUITests, PigeonHomeTilesUITests and the two
#           iPad-only tests.
#   smoke:  layout plus the UI tests in .github/ios-smoke-ui-tests.txt.
#   full:   every UI test.
#   unit:   also run the unit tests, on the first device only.
#
# A device that fails does not stop the others; the script exits 1 at the end
# if any device failed. Required env: PROJECT, SCHEME, DERIVED_DATA_PATH,
# LAYOUT_OUTPUT, RUNNER_TEMP, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.
set -uo pipefail

devices_csv="${1:-}"
suite="${2:-layout}"
unit_tests="${3:-}"
if [[ -z "$devices_csv" || ! "$suite" =~ ^(layout|smoke|full)$ || ! "$unit_tests" =~ ^(unit)?$ ]]; then
  echo "usage: $0 \"<device name prefix>,...\" layout|smoke|full [unit]" >&2
  exit 2
fi
: "${PROJECT:?}" "${SCHEME:?}" "${DERIVED_DATA_PATH:?}" "${LAYOUT_OUTPUT:?}" "${RUNNER_TEMP:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"

script_dir="$(cd "$(dirname "$0")" && pwd)"
session="$script_dir/ios-simulator-session.py"
ownership_file="$RUNNER_TEMP/pigeon-simulator-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.json"
mkdir -p "$LAYOUT_OUTPUT"

# A laptop runner that goes to sleep mid-run loses its connection, and GitHub
# fails the job ten minutes later with no log. Stay awake while this runs.
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -is -w $$ >/dev/null 2>&1 &
fi

only_testing=()
case "$suite" in
  layout|smoke)
    only_testing+=("-only-testing:PigeonReaderUITests/PigeonDeviceLayoutUITests")
    only_testing+=("-only-testing:PigeonReaderUITests/PigeonHomeTilesUITests")
    # The two tests that need an iPad, which CI's iPhone always skips.
    only_testing+=("-only-testing:PigeonReaderUITests/PigeonReaderRealStartupUITests/testIPadLandscapeStartupShowsSavedHomeAndRestoresStories")
    only_testing+=("-only-testing:PigeonReaderUITests/PigeonNavigationMotionUITests/testSwitchingFeedsKeepsTheRegularSidebarStationary")
    ;;
  full)
    only_testing+=("-only-testing:PigeonReaderUITests")
    ;;
esac
if [[ "$suite" == "smoke" ]]; then
  while IFS= read -r flag; do
    [[ -n "$flag" ]] || continue
    # The unit tests do not depend on the device; CI already runs them.
    [[ "$flag" == "-only-testing:PigeonReaderTests" ]] && continue
    only_testing+=("$flag")
  done <<< "$(python3 "$script_dir/ios_smoke_tests.py" args)"
fi

# Shuts down and unreserves the simulator this run holds, if any. Afterwards the
# workflow's own cleanup has nothing left to do.
release_device() {
  python3 "$session" finish "$ownership_file" || true
  rm -f "$ownership_file"
}

run_device() {
  local device="$1" output="$2"
  python3 "$session" ensure "$device" || return 1
  # `start` reserves the simulator before it boots it, so a failed start can
  # leave a reservation behind. Release it, or no later run can use the device.
  PIGEON_SIMULATOR_DEVICE="$device" python3 "$session" start || { release_device; return 1; }
  local udid
  udid="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["udid"])' "$ownership_file")" || { release_device; return 1; }
  # The unit tests go to the first device that boots.
  local tests=("${only_testing[@]}")
  if [[ "$unit_tests" == "unit" ]]; then
    tests+=("-only-testing:PigeonReaderTests")
    unit_tests=""
  fi

  local log="$output/xcodebuild.log" result=0
  # xcodebuild hands TEST_RUNNER_* variables to the test runner without the prefix.
  TEST_RUNNER_PIGEON_LAYOUT_DIR="$output" TEST_RUNNER_PIGEON_LAYOUT_DEVICE="$device" \
    xcodebuild test \
      -jobs 2 \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -destination "platform=iOS Simulator,id=$udid" \
      -parallel-testing-enabled NO \
      -derivedDataPath "$DERIVED_DATA_PATH" \
      -resultBundlePath "$output/result.xcresult" \
      "${tests[@]}" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO > "$log" 2>&1 || result=$?

  # UI test results, compile errors, and failures from both XCTest and Swift
  # Testing. Passing unit tests are left out: there are thousands.
  grep -E "^Test Case .*UITests.*(passed|failed)|^Test Case .* failed|error:|recorded an issue|\*\* TEST|\*\* BUILD|Executed [0-9]+ tests|Test run with [0-9]+ tests|_BENCH " "$log" \
    | cut -c1-500 | head -n 300 || true
  if [[ "$result" -ne 0 ]]; then
    echo "xcodebuild exited $result on $device. Last lines of its log:"
    tail -n 60 "$log" | cut -c1-400
  fi
  if [[ "$result" -eq 0 && ! -s "$output/layout-log.txt" ]]; then
    # The walk skips itself without PIGEON_LAYOUT_DEVICE, so a green run with
    # no log means the TEST_RUNNER_ variables never reached the test runner.
    echo "The layout walk recorded nothing on $device."
    result=1
  fi
  release_device
  return "$result"
}

status=0
IFS=',' read -r -a devices <<< "$devices_csv"
for device in "${devices[@]}"; do
  device="$(printf '%s' "$device" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [[ -n "$device" ]] || continue
  slug="$(printf '%s' "$device" | tr -c 'A-Za-z0-9' '-')"
  output="$LAYOUT_OUTPUT/$slug"
  mkdir -p "$output"
  echo "::group::$device"
  if run_device "$device" "$output"; then
    echo "PIGEON-LAYOUT-RESULT|$device|passed" | tee -a "$LAYOUT_OUTPUT/results.txt"
  else
    status=1
    echo "PIGEON-LAYOUT-RESULT|$device|failed" | tee -a "$LAYOUT_OUTPUT/results.txt"
  fi
  echo "::endgroup::"
done
exit "$status"
