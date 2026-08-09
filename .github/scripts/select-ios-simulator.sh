#!/bin/bash

set -euo pipefail

destination="$({
  xcrun simctl list devices available --json
} | /usr/bin/python3 -c '
import json
import sys

payload = json.load(sys.stdin)
candidates = []

for runtime, devices in payload.get("devices", {}).items():
    runtime_name = runtime.rsplit(".", 1)[-1]
    if not runtime_name.startswith("iOS-"):
        continue

    try:
        version = tuple(int(part) for part in runtime_name.removeprefix("iOS-").split("-"))
    except ValueError:
        version = (0,)

    for device in devices:
        name = device.get("name", "")
        udid = device.get("udid")
        if name.startswith("iPhone") and udid:
            preference = 2 if name == "iPhone 17" else 1 if name.startswith("iPhone 17") else 0
            candidates.append((version, preference, udid))

if not candidates:
    raise SystemExit("No available iPhone simulator was found.")

selected = max(candidates, key=lambda candidate: (candidate[0], candidate[1]))
print(f"platform=iOS Simulator,id={selected[2]}")
')"

echo "destination=$destination" >> "$GITHUB_OUTPUT"
echo "Using destination: $destination"
