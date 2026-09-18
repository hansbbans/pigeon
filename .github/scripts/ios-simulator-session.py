#!/usr/bin/env python3
"""Reserve, boot, and clean up only a Pigeon workflow's simulator."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def run(*args):
    return subprocess.check_output(args, text=True)


def devices():
    return json.loads(run("xcrun", "simctl", "list", "devices", "available", "--json"))["devices"]


def active_use(udid, rows):
    simulator_roots = {pid for pid, _, command in rows
                       if "launchd_sim" in command and "/" + udid + "/" in command}
    descendants = set(simulator_roots)
    while True:
        children = {pid for pid, parent, _ in rows if parent in descendants}
        expanded = descendants | children
        if expanded == descendants:
            break
        descendants = expanded
    for pid, _, command in rows:
        if "xcodebuild" in command and udid in command:
            return True
        if pid in descendants and any(name in command.lower() for name in ("xctest", "xctrunner", "uitests-runner")):
            return True
        if "/Simulator.app/Contents/MacOS/Simulator" in command:
            # A manual Simulator session can change devices without changing its
            # process arguments. Preserve the device when current use is unclear.
            return True
    return False


def start():
    snapshot = devices()
    booted = [d["udid"] for group in snapshot.values() for d in group if d["state"] != "Shutdown"]
    candidates = []
    for runtime, group in snapshot.items():
        if ".iOS-" not in runtime:
            continue
        version = tuple(map(int, runtime.rsplit(".iOS-", 1)[1].split("-")))
        for device in group:
            if device["state"] == "Shutdown" and device["name"].startswith("iPhone"):
                preference = 2 if device["name"] == "iPhone 17" else 1 if device["name"].startswith("iPhone 17") else 0
                candidates.append((version, preference, device["udid"]))
    session = os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
    ownership_file = Path(os.environ["RUNNER_TEMP"]) / ("pigeon-simulator-" + session + ".json")
    for _, _, udid in sorted(candidates, reverse=True):
        lock = Path(tempfile.gettempdir()) / ("pigeon-simulator-" + udid + ".lock")
        try:
            with lock.open("x") as handle:
                handle.write(str(ownership_file))
        except FileExistsError:
            continue
        record = {"udid": udid, "session": session, "preexisting_booted": booted,
                  "boot_confirmed": False, "lock": str(lock)}
        ownership_file.write_text(json.dumps(record))
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write("ownership_file=" + str(ownership_file) + "\n")
            output.write("destination=platform=iOS Simulator,id=" + udid + "\n")
        current = next(d for group in devices().values() for d in group if d["udid"] == udid)
        if current["state"] != "Shutdown":
            raise RuntimeError("The selected simulator became busy before boot; preserving it")
        subprocess.run(["xcrun", "simctl", "boot", udid], check=True)
        record["boot_confirmed"] = True
        ownership_file.write_text(json.dumps(record))
        print("Booted task-owned simulator: " + udid, flush=True)
        return
    raise RuntimeError("No idle unreserved iPhone simulator is available")


def finish(path):
    if not path or not Path(path).is_file():
        print("No simulator was reserved by this job")
        return
    record = json.loads(Path(path).read_text())
    expected = os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
    if record["session"] != expected:
        raise RuntimeError("Simulator ownership belongs to a different run")
    udid = record["udid"]
    lock = Path(record["lock"])
    if not lock.is_file() or lock.read_text() != path:
        raise RuntimeError("Simulator reservation ownership changed; preserving device")
    if record["boot_confirmed"] and udid not in record["preexisting_booted"]:
        rows = []
        for line in run("ps", "-A", "-o", "pid=,ppid=,command=").splitlines():
            fields = line.strip().split(None, 2)
            if len(fields) == 3:
                rows.append((int(fields[0]), int(fields[1]), fields[2]))
        if active_use(udid, rows):
            print("::warning::Preserving owned simulator still in use: " + udid)
            # Future runs still require Shutdown; do not leave an orphaned lock
            # once this job has relinquished cleanup of the busy device.
            lock.unlink()
            return
        current = next(d for group in devices().values() for d in group if d["udid"] == udid)
        if current["state"] != "Shutdown":
            subprocess.run(["xcrun", "simctl", "shutdown", udid], check=True)
        current = next(d for group in devices().values() for d in group if d["udid"] == udid)
        if current["state"] != "Shutdown":
            raise RuntimeError("Simulator did not reach Shutdown: " + udid)
        print("Verified task-owned simulator Shutdown: " + udid)
    lock.unlink()


if __name__ == "__main__":
    if sys.argv[1] == "start":
        start()
    elif sys.argv[1] == "finish":
        finish(sys.argv[2] if len(sys.argv) > 2 else "")
    else:
        raise SystemExit("Expected start or finish")
