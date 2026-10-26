#!/usr/bin/env bash
# Kill xcodebuild/xctest processes left behind by earlier runs of this runner.
#
# A runner executes one job at a time, so any build or test process whose
# command line points into this runner's RUNNER_TEMP but carries a different
# run id was orphaned by a cancelled or timed-out job. Nothing else is touched:
# other runners' jobs and interactive simulator sessions keep running.
#
# Test hook: ORPHAN_PROCESS_LIST=<file> reads "pid command" lines from the file
# and reports matches without killing anything.
set -euo pipefail

runner_temp="${RUNNER_TEMP:?RUNNER_TEMP is required}"
current_run="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}-${GITHUB_RUN_ATTEMPT:-1}"
process_list="${ORPHAN_PROCESS_LIST:-}"

list_processes() {
  if [[ -n "$process_list" ]]; then
    cat "$process_list"
  else
    ps -axo pid=,command=
  fi
}

orphan_pids() {
  local pid command
  while read -r pid command; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    case "$command" in
      *xcodebuild*|*xctest*) ;;
      *) continue ;;
    esac
    [[ "$command" == *"${runner_temp%/}/"* ]] || continue
    [[ "$command" != *"$current_run"* ]] || continue
    printf '%s\t%s\n' "$pid" "$command"
  done < <(list_processes)
}

killed=0
while IFS=$'\t' read -r pid command; do
  [[ -n "$pid" ]] || continue
  echo "Killing orphaned process from an earlier run (pid $pid): ${command:0:220}"
  if [[ -z "$process_list" ]]; then
    kill "$pid" 2>/dev/null || true
  fi
  killed=$(( killed + 1 ))
done < <(orphan_pids)

if (( killed > 0 )) && [[ -z "$process_list" ]]; then
  sleep 10
  while IFS=$'\t' read -r pid command; do
    [[ -n "$pid" ]] || continue
    echo "Force-killing orphaned process that ignored SIGTERM (pid $pid)"
    kill -9 "$pid" 2>/dev/null || true
  done < <(orphan_pids)
fi

echo "Orphaned build processes handled: $killed"
