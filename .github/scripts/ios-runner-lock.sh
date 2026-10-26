#!/usr/bin/env bash
# Serialize iOS builds across every GitHub Actions runner on this Mac.
#
#   .github/scripts/ios-runner-lock.sh acquire   # wait until the lock is free, then take it
#   .github/scripts/ios-runner-lock.sh release   # drop the lock if this job holds it
#
# The lock is a directory (mkdir is atomic) shared by all runners on the
# machine. Its owner file records the job's Runner.Worker PID; a lock whose
# holder process is gone is abandoned and replaced at once. Age-based rules
# are the backstop when no PID is available.
set -euo pipefail

action="${1:-}"
lock_dir="${IOS_RUNNER_LOCK_DIR:-/tmp/ios-ci-runner.lock}"
# Outside Actions the owner is the user name, so acquire and release from
# separate shells still agree.
owner="${IOS_RUNNER_LOCK_OWNER:-${GITHUB_REPOSITORY:-local}#${GITHUB_RUN_ID:-$(id -un)}-${GITHUB_RUN_ATTEMPT:-1}}"
wait_seconds="${IOS_RUNNER_LOCK_WAIT_SECONDS:-3600}"
stale_seconds="${IOS_RUNNER_LOCK_STALE_SECONDS:-10800}"
# A lock directory without an owner file is either mid-acquire (a few
# milliseconds) or left over from a killed acquire; treat it as abandoned once
# it is this old.
ownerless_seconds="${IOS_RUNNER_LOCK_OWNERLESS_SECONDS:-60}"
poll_seconds="${IOS_RUNNER_LOCK_POLL_SECONDS:-15}"
# The step's shell. When the runner cancels the step it kills that shell but
# not this script, so the script must notice and stop on its own.
parent_pid="${IOS_RUNNER_LOCK_PARENT_PID:-$PPID}"

process_alive() {
  [[ "$1" =~ ^[0-9]+$ ]] && ps -p "$1" >/dev/null 2>&1
}

# The PID that lives for the whole job: the Runner.Worker above the step
# shell. Falls back to the grandparent when no worker is found (local use).
job_pid() {
  if [[ -n "${IOS_RUNNER_LOCK_HOLDER_PID:-}" ]]; then
    echo "$IOS_RUNNER_LOCK_HOLDER_PID"
    return
  fi
  local pid="$parent_pid" command grandparent
  grandparent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  for _ in 1 2 3 4 5 6; do
    [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || break
    command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    if [[ "$command" == *Runner.Worker* ]]; then
      echo "$pid"
      return
    fi
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  done
  echo "${grandparent:-$parent_pid}"
}

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
  sed -n '1p' "$lock_dir/owner" 2>/dev/null || true
}

current_holder_pid() {
  sed -n '2p' "$lock_dir/owner" 2>/dev/null || true
}

abandoned_reason() {
  local holder="$1" holder_pid="$2" age="$3"
  if [[ -z "$holder" ]]; then
    (( age > ownerless_seconds )) && echo "no owner was recorded for ${age}s"
    return 0
  fi
  if [[ "$holder_pid" =~ ^[0-9]+$ ]] && ! process_alive "$holder_pid"; then
    echo "holder process $holder_pid is gone"
    return 0
  fi
  (( age > stale_seconds )) && echo "held for ${age}s"
  return 0
}

acquire() {
  local waited=0 age holder holder_pid reason stale_dir
  while ! mkdir "$lock_dir" 2>/dev/null; do
    if ! process_alive "$parent_pid"; then
      echo "The step that started this wait is gone; not taking the iOS runner lock" >&2
      exit 1
    fi
    holder="$(current_owner)"
    holder_pid="$(current_holder_pid)"
    age="$(lock_age)"
    reason="$(abandoned_reason "$holder" "$holder_pid" "$age")"
    if [[ -n "$reason" ]]; then
      echo "::warning::Replacing an abandoned iOS runner lock (${holder:-no owner}): $reason"
      # Only one waiter can rename the directory, so only one replaces it.
      stale_dir="$lock_dir.stale.$$.$RANDOM"
      if mv "$lock_dir" "$stale_dir" 2>/dev/null; then
        rm -rf "$stale_dir"
      fi
      continue
    fi
    if (( waited >= wait_seconds )); then
      echo "Gave up after waiting ${waited}s for the iOS runner lock held by ${holder:-unknown}" >&2
      exit 1
    fi
    echo "Waiting for the iOS runner lock held by ${holder:-unknown} (${age}s old, waited ${waited}s)"
    sleep "$poll_seconds"
    waited=$(( waited + poll_seconds ))
  done
  if ! process_alive "$parent_pid"; then
    rmdir "$lock_dir" 2>/dev/null || true
    echo "The step that started this wait is gone; released the iOS runner lock again" >&2
    exit 1
  fi
  printf '%s\n%s\n' "$owner" "$(job_pid)" > "$lock_dir/owner"
  echo "Acquired the iOS runner lock as $owner (job pid $(sed -n '2p' "$lock_dir/owner"))"
}

release() {
  if [[ ! -d "$lock_dir" ]]; then
    echo "No iOS runner lock to release"
    return
  fi
  local holder
  holder="$(current_owner)"
  if [[ "$holder" != "$owner" ]]; then
    echo "The iOS runner lock belongs to ${holder:-nobody yet}; leaving it in place"
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
