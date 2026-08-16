#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <xcodebuild-log>" >&2
  exit 2
fi

log_path="$1"
if [[ ! -f "$log_path" ]]; then
  echo "xcodebuild log not found: $log_path" >&2
  exit 2
fi

warning_pattern='(/ios/PigeonReader/|/PigeonReader/|PigeonReader/).*(warning:|warning )'
first_party_warnings="$(grep -E -i "$warning_pattern" "$log_path" || true)"

if [[ -n "$first_party_warnings" ]]; then
  echo "First-party Xcode warnings are not allowed:" >&2
  echo "$first_party_warnings" >&2
  exit 1
fi

echo "No first-party Xcode warnings found."
