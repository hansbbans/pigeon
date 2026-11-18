#!/bin/bash
# Runs the device layout walk on each requested simulator family, one after
# the other, and collects screenshots, layout dumps and logs.
#
#   run-ios-device-layout.sh "<name prefix>,<name prefix>,..." layout|smoke|full
#
#   layout: PigeonDeviceLayoutUITests and PigeonHomeTilesUITests.
#   smoke:  layout plus the UI tests in .github/ios-smoke-ui-tests.txt.
#   full:   every UI test.
#
# A device that fails does not stop the others; the script exits 1 at the end
# if any device failed. Required env: PROJECT, SCHEME, DERIVED_DATA_PATH,
# LAYOUT_OUTPUT, RUNNER_TEMP, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT.
set -uo pipefail

devices_csv="${1:-}"
suite="${2:-layout}"
if [[ -z "$devices_csv" || ! "$suite" =~ ^(layout|smoke|full)$ ]]; then
  echo "usage: $0 \"<device name prefix>,...\" layout|smoke|full" >&2
  exit 2
fi
: "${PROJECT:?}" "${SCHEME:?}" "${DERIVED_DATA_PATH:?}" "${LAYOUT_OUTPUT:?}" "${RUNNER_TEMP:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"

script_dir="$(cd "$(dirname "$0")" && pwd)"
session="$script_dir/ios-simulator-session.py"
ownership_file="$RUNNER_TEMP/pigeon-simulator-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.json"
mkdir -p "$LAYOUT_OUTPUT"

only_testing=()
case "$suite" in
  layout|smoke)
    only_testing+=("-only-testing:PigeonReaderUITests/PigeonDeviceLayoutUITests")
    only_testing+=("-only-testing:PigeonReaderUITests/PigeonHomeTilesUITests")
    ;;
  full)
    only_testing+=("-only-testing:PigeonReaderUITests")
    ;;
esac
if [[ "$suite" == "smoke" ]]; then
  while IFS= read -r flag; do
    # The unit tests do not depend on the device; CI already runs them.
    [[ "$flag" == "-only-testing:PigeonReaderTests" ]] && continue
    only_testing+=("$flag")
  done <<< "$(python3 "$script_dir/ios_smoke_tests.py" args)"
fi

run_device() {
  local device="$1" output="$2"
  python3 "$session" ensure "$device" || return 1
  PIGEON_SIMULATOR_DEVICE="$device" python3 "$session" start || return 1
  local udid
  udid="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["udid"])' "$ownership_file")" || return 1

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
      "${only_testing[@]}" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO > "$log" 2>&1 || result=$?

  grep -E "^Test Case .*(passed|failed)|^Test Suite 'All tests'|error:|\*\* TEST|\*\* BUILD|Executed [0-9]+ tests" "$log" | cut -c1-400 || true
  if [[ "$result" -ne 0 ]]; then
    echo "xcodebuild exited $result on $device. Last lines of its log:"
    tail -n 60 "$log" | cut -c1-400
  fi
  python3 "$session" finish "$ownership_file" || true
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
