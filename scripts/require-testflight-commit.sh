#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${EXPECTED_RELEASE_SHA:-}" ]]; then
  if [[ ! "$EXPECTED_RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]]; then
    echo "expected_sha must be a full lowercase commit SHA." >&2
    exit 1
  fi
  if [[ "$GITHUB_SHA" != "$EXPECTED_RELEASE_SHA" ]]; then
    echo "main advanced before dispatch; refusing to release a different commit." >&2
    exit 1
  fi
fi

checked_out_sha="$(git rev-parse HEAD)"
if [[ "$checked_out_sha" != "$GITHUB_SHA" ]]; then
  echo "main advanced between dispatch and checkout; refusing to release a different commit." >&2
  exit 1
fi
