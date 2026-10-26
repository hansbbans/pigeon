#!/usr/bin/env bash
# Serialize iOS builds across every GitHub Actions runner on this Mac.
#
#   .github/scripts/ios-runner-lock.sh acquire   # wait until the lock is free, then take it
#   .github/scripts/ios-runner-lock.sh release   # drop the lock if this job holds it
#
# The lock is a directory (mkdir is atomic) shared by all runners on the
# machine. A holder that vanished without releasing is replaced once the lock
# is older than IOS_RUNNER_LOCK_STALE_SECONDS.
set -euo pipefail

action="${1:-}"
lock_dir="${IOS_RUNNER_LOCK_DIR:-/tmp/ios-ci-runner.lock}"
owner="${IOS_RUNNER_LOCK_OWNER:-${GITHUB_REPOSITORY:-local}#${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}}"
wait_seconds="${IOS_RUNNER_LOCK_WAIT_SECONDS:-3600}"
stale_seconds="${IOS_RUNNER_LOCK_STALE_SECONDS:-10800}"
poll_seconds="${IOS_RUNNER_LOCK_POLL_SECONDS:-15}"

lock_age() {
  # `date -r FILE` reports the modification time on both macOS and GNU
  # coreutils (the tooling tests run on Linux). An unreadable lock counts as new.
  local modified
  modified="$(date -r "$lock_dir" +%s 2>/dev/null || true)"
  if [[ ! "$modified" =~ ^[0-9]+$ ]]; then
    echo 0
    return
  fi
  echo $(( $(date +%s) - modified ))
}

current_owner() {
  cat "$lock_dir/owner" 2>/dev/null || echo "unknown"
}

acquire() {
  local waited=0 age holder
  while ! mkdir "$lock_dir" 2>/dev/null; do
    holder="$(current_owner)"
    age="$(lock_age)"
    if (( age > stale_seconds )); then
      echo "::warning::Replacing a stale iOS runner lock held by $holder for ${age}s"
      rm -rf "$lock_dir"
      continue
    fi
    if (( waited >= wait_seconds )); then
      echo "Gave up after waiting ${waited}s for the iOS runner lock held by $holder" >&2
      exit 1
    fi
    echo "Waiting for the iOS runner lock held by $holder (${age}s old, waited ${waited}s)"
    sleep "$poll_seconds"
    waited=$(( waited + poll_seconds ))
  done
  printf '%s\n' "$owner" > "$lock_dir/owner"
  echo "Acquired the iOS runner lock as $owner"
}

release() {
  if [[ ! -d "$lock_dir" ]]; then
    echo "No iOS runner lock to release"
    return
  fi
  if [[ "$(current_owner)" != "$owner" ]]; then
    echo "The iOS runner lock belongs to $(current_owner); leaving it in place"
    return
  fi
  rm -rf "$lock_dir"
  echo "Released the iOS runner lock held by $owner"
}

case "$action" in
  acquire) acquire ;;
  release) release ;;
  *)
    echo "usage: $0 acquire|release" >&2
    exit 64
    ;;
esac
