import importlib.util
import sys
sys.dont_write_bytecode = True
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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

    def test_start_records_only_a_successful_boot_as_owned(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = {"GITHUB_RUN_ID": "42", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_TEMP": directory, "GITHUB_OUTPUT": str(Path(directory) / "outputs")}
            snapshot = {"com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
                {"name": "iPhone 17", "udid": "preexisting", "state": "Booted"},
                {"name": "iPhone 17", "udid": "owned", "state": "Shutdown"},
            ]}
            with patch.dict(os.environ, environment), patch.object(session, "devices", return_value=snapshot), patch.object(session.tempfile, "gettempdir", return_value=directory), patch.object(session.subprocess, "run") as command:
                session.start()
                command.assert_called_once_with(["xcrun", "simctl", "boot", "owned"], check=True)
            record = json.loads((Path(directory) / "pigeon-simulator-42-1.json").read_text())
            self.assertTrue(record["boot_confirmed"])
            self.assertEqual(record["preexisting_booted"], ["preexisting"])

    def test_failed_boot_never_claims_the_device(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = {"GITHUB_RUN_ID": "42", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_TEMP": directory, "GITHUB_OUTPUT": str(Path(directory) / "outputs")}
            snapshot = {"com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{"name": "iPhone 17", "udid": "owned", "state": "Shutdown"}]}
            with patch.dict(os.environ, environment), patch.object(session, "devices", return_value=snapshot), patch.object(session.tempfile, "gettempdir", return_value=directory), patch.object(session.subprocess, "run", side_effect=session.subprocess.CalledProcessError(1, "simctl")):
                with self.assertRaises(session.subprocess.CalledProcessError):
                    session.start()
            record = json.loads((Path(directory) / "pigeon-simulator-42-1.json").read_text())
            self.assertFalse(record["boot_confirmed"])

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
