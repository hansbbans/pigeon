#!/usr/bin/env bash
set -euo pipefail

project="${1:-ios/PigeonReader/PigeonReader.xcodeproj}"

if [[ ! -d "$project" ]]; then
  echo "Xcode project not found: $project" >&2
  exit 1
fi

verify_target() {
  local target="$1"
  local input_name="$2"
  local expected="$3"
  local settings
  local actual

  if ! settings="$(xcodebuild \
    -project "$project" \
    -target "$target" \
    -showBuildSettings \
    "$input_name=$expected" 2>&1)"; then
    echo "xcodebuild -showBuildSettings failed for target $target" >&2
    printf '%s\n' "$settings" >&2
    return 1
  fi

  actual="$(printf '%s\n' "$settings" | awk -F ' = ' '
    $1 ~ /^[[:space:]]*PROVISIONING_PROFILE_SPECIFIER[[:space:]]*$/ {
      sub(/[[:space:]]*$/, "", $2)
      print $2
      exit
    }
  ')"

  if [[ "$actual" != "$expected" ]]; then
    echo "Target $target resolved PROVISIONING_PROFILE_SPECIFIER to '${actual:-<empty>}' (expected $expected)" >&2
    return 1
  fi

  echo "$target: PROVISIONING_PROFILE_SPECIFIER = $actual (via $input_name)"
}

verify_target PigeonReader PIGEON_READER_PROFILE_NAME MainProfile
verify_target PigeonWidgets PIGEON_WIDGETS_PROFILE_NAME WidgetsProfile
verify_target PigeonShareExtension PIGEON_SHARE_PROFILE_NAME ShareProfile
