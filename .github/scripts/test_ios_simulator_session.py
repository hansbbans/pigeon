import importlib.util
import sys
sys.dont_write_bytecode = True
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import call, patch

spec = importlib.util.spec_from_file_location("simulator_session", Path(__file__).with_name("ios-simulator-session.py"))
session = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session)


class SimulatorOwnershipTests(unittest.TestCase):
    def test_detects_targeted_build_and_native_test_descendants(self):
        self.assertTrue(session.active_use("owned", [(1, 0, "xcodebuild -destination id=owned")]))
        self.assertTrue(session.active_use("owned", [(1, 0, "launchd_sim /Devices/owned/data"), (2, 1, "PigeonReaderUITests-Runner")]))
        self.assertFalse(session.active_use("owned", [(1, 0, "launchd_sim /Devices/other/data"), (2, 1, "PigeonReaderUITests-Runner")]))

    def test_manual_simulator_session_is_preserved(self):
        self.assertTrue(session.active_use("owned", [(1, 0, "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator")]))

    def test_unbooted_reservation_never_shuts_down_a_device(self):
        self.check_cleanup(boot_confirmed=False, expect_shutdown=False)

    def test_preexisting_booted_device_is_preserved(self):
        self.check_cleanup(preexisting=["owned"], expect_shutdown=False)

    def test_owned_idle_device_is_shutdown_and_verified(self):
        self.check_cleanup(expect_shutdown=True)

    def test_active_owned_device_is_preserved_without_leaving_a_stale_reservation(self):
        self.check_cleanup(processes="1 0 xcodebuild -destination id=owned", expect_shutdown=False)

    def run_start(self, snapshot, outcomes=None, raises=None):
        """Run start() against a device snapshot; return the ownership record, the
        simctl calls made, and the reservation lock's content (None if absent)."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ownership = root / "pigeon-simulator-42-1.json"
            environment = {"GITHUB_RUN_ID": "42", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_TEMP": directory, "GITHUB_OUTPUT": str(root / "outputs")}
            with patch.dict(os.environ, environment), patch.object(session, "devices", return_value=snapshot), patch.object(session.tempfile, "gettempdir", return_value=directory), patch.object(session.subprocess, "run", side_effect=outcomes) as command:
                if raises is None:
                    session.start()
                else:
                    with self.assertRaises(raises):
                        session.start()
            lock = root / "pigeon-simulator-owned.lock"
            return json.loads(ownership.read_text()), command.call_args_list, (lock.read_text() if lock.is_file() else None), str(ownership)

    def test_start_records_only_a_successful_boot_as_owned(self):
        snapshot = {"com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
            {"name": "iPhone 17", "udid": "preexisting", "state": "Booted"},
            {"name": "iPhone 17", "udid": "owned", "state": "Shutdown"},
        ]}
        record, calls, lock_target, ownership = self.run_start(snapshot)
        self.assertEqual(calls, [
            call(["xcrun", "simctl", "boot", "owned"], check=True),
            call(["xcrun", "simctl", "bootstatus", "owned", "-b"], check=True, timeout=session.BOOT_TIMEOUT_SECONDS),
        ])
        self.assertTrue(record["boot_confirmed"])
        self.assertEqual(record["preexisting_booted"], ["preexisting"])
        self.assertEqual(lock_target, ownership)

    def test_boot_that_never_finishes_still_owns_the_device_and_continues(self):
        snapshot = {"com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{"name": "iPhone 17", "udid": "owned", "state": "Shutdown"}]}
        outcomes = [None, session.subprocess.TimeoutExpired("bootstatus", session.BOOT_TIMEOUT_SECONDS)]
        record, calls, lock_target, ownership = self.run_start(snapshot, outcomes)
        self.assertEqual(len(calls), 2)
        self.assertTrue(record["boot_confirmed"], "a booted device must be shut down at cleanup even if the boot wait timed out")
        self.assertEqual(lock_target, ownership, "the reservation must survive a timed-out boot wait so cleanup still owns the device")

    def test_failed_boot_never_claims_the_device(self):
        snapshot = {"com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{"name": "iPhone 17", "udid": "owned", "state": "Shutdown"}]}
        record, calls, lock_target, ownership = self.run_start(snapshot, session.subprocess.CalledProcessError(1, "simctl"), raises=session.subprocess.CalledProcessError)
        self.assertEqual(len(calls), 1)
        self.assertFalse(record["boot_confirmed"])

    def test_default_selection_is_an_iphone_and_prefers_iphone_17(self):
        self.assertIsNone(session.preference("iPad mini (A17 Pro)", ""))
        self.assertEqual(session.preference("iPhone 17", ""), 2)
        self.assertEqual(session.preference("iPhone 17 Pro", ""), 1)
        self.assertEqual(session.preference("iPhone 16", ""), 0)

    def test_requested_device_family_replaces_the_iphone_default(self):
        self.assertIsNone(session.preference("iPhone 17", "iPad mini"))
        self.assertEqual(session.preference("iPad mini (A17 Pro)", "iPad mini"), 0)
        self.assertEqual(session.preference("iPhone 17 Pro", "iPhone 17 Pro"), 1)
        self.assertEqual(session.preference("iPhone 17 Pro Max", "iPhone 17 Pro"), 0)

    def test_start_boots_only_the_requested_device_family(self):
        snapshot = {"com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
            {"name": "iPhone 17", "udid": "phone", "state": "Shutdown"},
            {"name": "iPad mini (A17 Pro)", "udid": "owned", "state": "Shutdown"},
        ]}
        with patch.dict(os.environ, {"PIGEON_SIMULATOR_DEVICE": "iPad mini"}):
            record, calls, lock_target, ownership = self.run_start(snapshot)
        self.assertEqual(record["udid"], "owned")
        self.assertEqual(calls[0], call(["xcrun", "simctl", "boot", "owned"], check=True))

    def test_ensure_creates_a_missing_family_on_the_newest_runtime(self):
        device_types = json.dumps({"devicetypes": [
            {"name": "iPad mini (6th generation)", "identifier": "type.mini-6"},
            {"name": "iPad mini (A17 Pro)", "identifier": "type.mini-a17"},
            {"name": "iPhone 17", "identifier": "type.iphone-17"},
        ]})
        runtimes = json.dumps({"runtimes": [
            {"identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-0", "isAvailable": True},
            {"identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-5", "isAvailable": True},
            {"identifier": "com.apple.CoreSimulator.SimRuntime.iOS-27-0", "isAvailable": False},
            {"identifier": "com.apple.CoreSimulator.SimRuntime.watchOS-26-0", "isAvailable": True},
        ]})
        snapshot = {"com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{"name": "iPhone 17", "udid": "phone", "state": "Shutdown"}]}
        with patch.object(session, "devices", return_value=snapshot), patch.object(session, "run", side_effect=[device_types, runtimes]), patch.object(session.subprocess, "run") as command:
            session.ensure("iPad mini")
        command.assert_called_once_with(["xcrun", "simctl", "create", "iPad mini (A17 Pro)", "type.mini-a17", "com.apple.CoreSimulator.SimRuntime.iOS-26-5"], check=True)

    def test_ensure_leaves_an_existing_family_alone(self):
        snapshot = {"com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{"name": "iPad mini (A17 Pro)", "udid": "tablet", "state": "Booted"}]}
        with patch.object(session, "devices", return_value=snapshot), patch.object(session, "run") as listing, patch.object(session.subprocess, "run") as command:
            session.ensure("iPad mini")
        listing.assert_not_called()
        command.assert_not_called()

    def check_cleanup(self, boot_confirmed=True, preexisting=None, processes="", expect_shutdown=False, expect_lock=False):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / "ownership.json"
            lock = Path(directory) / "reservation.lock"
            lock.write_text(str(record))
            record.write_text(json.dumps({"udid": "owned", "session": "42-1", "preexisting_booted": preexisting or [], "boot_confirmed": boot_confirmed, "lock": str(lock)}))
            before = {"runtime": [{"udid": "owned", "state": "Booted"}]}
            after = {"runtime": [{"udid": "owned", "state": "Shutdown"}]}
            with patch.dict(os.environ, {"GITHUB_RUN_ID": "42", "GITHUB_RUN_ATTEMPT": "1"}), patch.object(session, "run", return_value=processes), patch.object(session, "devices", side_effect=[before, after]), patch.object(session.subprocess, "run") as command:
                session.finish(str(record))
                if expect_shutdown:
                    command.assert_called_once_with(["xcrun", "simctl", "shutdown", "owned"], check=True)
                else:
                    command.assert_not_called()
                self.assertEqual(lock.exists(), expect_lock)


if __name__ == "__main__":
    unittest.main()
