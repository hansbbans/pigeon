#!/bin/bash
# Runs the native test suite for CI.
#   full:  every test in the PigeonReader scheme (unit tests and all UI tests).
#   smoke: all PigeonReaderTests plus the UI tests in .github/ios-smoke-ui-tests.txt.
# DRY_RUN=1 prints the xcodebuild command instead of running it.
# Required env (unless DRY_RUN=1 supplies placeholders): PROJECT, SCHEME,
# DESTINATION, DERIVED_DATA_PATH, TEST_RESULT_BUNDLE, RUNNER_TEMP.
set -euo pipefail

mode="${1:-}"
if [[ "$mode" != "full" && "$mode" != "smoke" ]]; then
  echo "usage: $0 full|smoke" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
dry_run="${DRY_RUN:-0}"
if [[ "$dry_run" == "1" ]]; then
  : "${PROJECT:=ios/PigeonReader/PigeonReader.xcodeproj}"
  : "${SCHEME:=PigeonReader}"
  : "${DESTINATION:=id=<reserved-simulator-udid>}"
  : "${DERIVED_DATA_PATH:=<derived-data>}"
  : "${TEST_RESULT_BUNDLE:=<result-bundle>.xcresult}"
  : "${RUNNER_TEMP:=${TMPDIR:-/tmp}}"
fi
: "${PROJECT:?}" "${SCHEME:?}" "${DESTINATION:?}" "${DERIVED_DATA_PATH:?}" "${TEST_RESULT_BUNDLE:?}" "${RUNNER_TEMP:?}"

command=(
  xcodebuild test
  -jobs 2
  -project "$PROJECT"
  -scheme "$SCHEME"
  -destination "$DESTINATION"
  -parallel-testing-enabled NO
  -derivedDataPath "$DERIVED_DATA_PATH"
  -resultBundlePath "$TEST_RESULT_BUNDLE"
)
if [[ "$mode" == "smoke" ]]; then
  # Fails here, before any build, if an entry no longer names a real test.
  only_testing="$(python3 "$script_dir/ios_smoke_tests.py" args)"
  while IFS= read -r flag; do
    command+=("$flag")
  done <<< "$only_testing"
fi
command+=(CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO)

if [[ "$dry_run" == "1" ]]; then
  printf '%q ' "${command[@]}"
  printf '\n'
  exit 0
fi

test_log="$RUNNER_TEMP/pigeon-xcode-test.log"
"${command[@]}" 2>&1 | tee "$test_log"
"$script_dir/fail-on-first-party-warnings.sh" "$test_log"
if [[ "$mode" == "smoke" ]]; then
  python3 "$script_dir/ios_smoke_tests.py" verify-log "$test_log"
fi
