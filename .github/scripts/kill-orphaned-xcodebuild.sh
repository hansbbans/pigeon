#!/usr/bin/env bash
# Kill xcodebuild/xctest processes left behind by earlier jobs on this runner.
#
# A runner executes one job at a time and this script runs before the current
# job starts any build, so every xcodebuild/xctest whose command line points
# into this runner's work directory was orphaned by a cancelled or timed-out
# job. The work directory is RUNNER_TEMP's parent (`_work`), which holds both
# the checkout (archive and export paths) and `_temp` (derived data). As a
# guard, processes that name the current run id are never touched. Nothing
# else is: other runners' jobs and interactive Simulator sessions keep running.
#
# Each orphan's descendants (build service, compilers, test hosts) go with it:
# they are what keeps the Mac busy once the xcodebuild front-end is gone.
#
# At the end of a job, ORPHAN_INCLUDE_CURRENT_RUN=1 also kills this run's own
# leftovers: a cancelled step's xcodebuild outlives the step shell.
#
# Test hook: ORPHAN_PROCESS_LIST=<file> reads "pid ppid command" lines from the
# file and reports matches without killing anything.
set -euo pipefail

runner_temp="${RUNNER_TEMP:?RUNNER_TEMP is required}"
runner_work_root="${RUNNER_WORK_ROOT:-$(dirname "$runner_temp")}"
current_run="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}-${GITHUB_RUN_ATTEMPT:-1}"
include_current_run="${ORPHAN_INCLUDE_CURRENT_RUN:-}"
grace_seconds="${ORPHAN_KILL_GRACE_SECONDS:-10}"
process_list="${ORPHAN_PROCESS_LIST:-}"

# The scope must be a runner's `_work` directory. A shallow RUNNER_TEMP (say
# /tmp when reproducing locally) would otherwise match every build on the Mac.
if [[ "$runner_work_root" != */_work ]]; then
  echo "Refusing to look for orphans: $runner_work_root is not a runner _work directory" >&2
  exit 1
fi

snapshot="$(mktemp "${TMPDIR:-/tmp}/orphan-processes.XXXXXX")"
trap 'rm -f "$snapshot"' EXIT

# A failed process listing must stop the job rather than pass as "no orphans".
snapshot_processes() {
  if [[ -n "$process_list" ]]; then
    cat "$process_list" > "$snapshot"
  elif ! ps -axo pid=,ppid=,command= > "$snapshot"; then
    echo "Unable to list processes; not starting a build next to possible orphans" >&2
    exit 1
  fi
}

# Orphaned build front-ends: "pid<TAB>command" lines.
orphan_roots() {
  local pid ppid command
  while read -r pid ppid command; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    case "$command" in
      *xcodebuild*|*xctest*) ;;
      *) continue ;;
    esac
    [[ "$command" == *"${runner_work_root%/}/"* ]] || continue
    # The run id appears as a path component or suffix (".../todomd-ci/<run>-<attempt>/",
    # "pigeon-ci-<run>-<attempt>", "...-<run>-<attempt>.xcresult"); anchor it so
    # neighbouring ids such as 1<run> or <run>-10 are not spared.
    if [[ -z "$include_current_run" && "$command" =~ [-/]${current_run}([/. ]|$) ]]; then
      continue
    fi
    printf '%s\t%s\n' "$pid" "$command"
  done < "$snapshot"
}

# Every descendant of the given pids, as "pid<TAB>parent<TAB>command" lines.
descendants_of() {
  local wanted=" $* " found changed=1 pid ppid command
  while (( changed )); do
    changed=0
    while read -r pid ppid command; do
      [[ "$pid" =~ ^[0-9]+$ && "$ppid" =~ ^[0-9]+$ ]] || continue
      if [[ "$wanted" == *" $ppid "* && "$wanted" != *" $pid "* ]]; then
        wanted+="$pid "
        changed=1
        printf '%s\t%s\t%s\n' "$pid" "$ppid" "$command"
      fi
    done < "$snapshot"
  done
}

snapshot_processes
roots=()
doomed=()
while IFS=$'\t' read -r pid command; do
  [[ -n "$pid" ]] || continue
  echo "Killing orphaned process from an earlier job (pid $pid): ${command:0:220}"
  roots+=("$pid")
  doomed+=("$pid")
done < <(orphan_roots)

if (( ${#roots[@]} > 0 )); then
  while IFS=$'\t' read -r pid ppid command; do
    [[ -n "$pid" ]] || continue
    echo "Killing descendant of an orphaned process (pid $pid, parent $ppid): ${command:0:220}"
    doomed+=("$pid")
  done < <(descendants_of "${roots[@]}")
fi

if (( ${#doomed[@]} > 0 )) && [[ -z "$process_list" ]]; then
  # SIGTERM lets xcodebuild cancel its build; whatever is left after the grace
  # period, including children reparented when a front-end died, is killed.
  for pid in "${roots[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  sleep "$grace_seconds"
  for pid in "${doomed[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "Force-killing process that ignored SIGTERM (pid $pid)"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
fi

echo "Orphaned build processes handled: ${#doomed[@]}"
