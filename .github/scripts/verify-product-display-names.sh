#!/usr/bin/env bash
set -euo pipefail

root="${1:-.}"

verify_display_name() {
  local label="$1"
  local relative_path="$2"
  local expected="$3"
  local plist="$root/$relative_path"
  local actual

  if [[ ! -f "$plist" ]]; then
    echo "Plist not found for $label: $plist" >&2
    return 1
  fi

  actual="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$plist")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label resolved CFBundleDisplayName to '$actual' (expected $expected)" >&2
    return 1
  fi

  echo "$label: CFBundleDisplayName = $actual"
}

verify_display_name PigeonReader ios/PigeonReader/PigeonReader/Resources/Info.plist Pigeon
verify_display_name PigeonWidgets ios/PigeonReader/PigeonWidgets/Info.plist "Pigeon Widgets"
verify_display_name PigeonShareExtension ios/PigeonReader/PigeonShareExtension/Info.plist "Add to Pigeon"
