#!/usr/bin/env python3
"""Fixture coverage for the smoke UI test list guard."""
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
sys.dont_write_bytecode = True

import ios_smoke_tests as smoke

SWIFT = """import XCTest

@MainActor
final class FeedUITests: XCTestCase {
\tfunc testOpensFeed() throws {
\t\tXCTAssertTrue(true)
\t}

\tprivate func helperNotATest() {}
}

private func testLooksLikeATestButIsTopLevel() {}

final class StartupUITests: XCTestCase {
\t@MainActor
\tfunc testStartsUp() {}
}

extension FeedUITests {
\tfunc testFromExtension() {}
}
"""


class SmokeListTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        (self.dir / "UITests").mkdir()
        (self.dir / "UITests" / "Feed.swift").write_text(SWIFT)
        self.list = self.dir / "smoke.txt"

    def tearDown(self):
        self.temp.cleanup()

    def run_check(self, *lines):
        self.list.write_text("\n".join(lines) + "\n")
        return smoke.check(self.list, self.dir / "UITests")

    def test_existing_methods_pass_and_comments_are_ignored(self):
        entries, errors = self.run_check(
            "# comment", "",
            "PigeonReaderUITests/FeedUITests/testOpensFeed",
            "  PigeonReaderUITests/StartupUITests/testStartsUp  ",
            "PigeonReaderUITests/FeedUITests/testFromExtension",
        )
        self.assertEqual(errors, [])
        self.assertEqual(len(entries), 3)

    def test_stale_or_malformed_entries_fail(self):
        for line in [
            "PigeonReaderUITests/FeedUITests/testRenamedAway",
            "PigeonReaderUITests/MissingUITests/testOpensFeed",
            "PigeonReaderUITests/StartupUITests/testOpensFeed",
            "PigeonReaderUITests/FeedUITests/helperNotATest",
            "PigeonReaderUITests/FeedUITests",
            "PigeonReaderTests/FeedUITests/testOpensFeed",
            "PigeonReaderUITests/FeedUITests/testOpensFeed()",
        ]:
            with self.subTest(line=line):
                self.assertTrue(self.run_check(line)[1])

    def test_top_level_functions_are_not_class_methods(self):
        self.assertTrue(self.run_check("PigeonReaderUITests/FeedUITests/testLooksLikeATestButIsTopLevel")[1])

    def test_empty_and_duplicate_lists_fail(self):
        self.assertTrue(self.run_check("# nothing here")[1])
        line = "PigeonReaderUITests/FeedUITests/testOpensFeed"
        self.assertTrue(self.run_check(line, line)[1])

    def test_args_put_unit_tests_first_and_every_entry_after(self):
        self.list.write_text("PigeonReaderUITests/FeedUITests/testOpensFeed\nPigeonReaderUITests/StartupUITests/testStartsUp\n")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = smoke.main(["args", "--list", str(self.list), "--tests-dir", str(self.dir / "UITests")])
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue().splitlines(), [
            "-only-testing:PigeonReaderTests",
            "-only-testing:PigeonReaderUITests/FeedUITests/testOpensFeed",
            "-only-testing:PigeonReaderUITests/StartupUITests/testStartsUp",
        ])

    def test_args_refuse_a_stale_list(self):
        self.list.write_text("PigeonReaderUITests/FeedUITests/testGone\n")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = smoke.main(["args", "--list", str(self.list), "--tests-dir", str(self.dir / "UITests")])
        self.assertEqual(code, 1)
        self.assertEqual(out.getvalue(), "")

    def test_verify_log_requires_every_listed_test_to_run(self):
        self.list.write_text("PigeonReaderUITests/FeedUITests/testOpensFeed\nPigeonReaderUITests/StartupUITests/testStartsUp\n")
        log = self.dir / "xcodebuild.log"
        passed = "Test Case '-[PigeonReaderUITests.FeedUITests testOpensFeed]' passed (3.1 seconds).\n"
        skipped = "Test Case '-[PigeonReaderUITests.StartupUITests testStartsUp]' skipped (0.2 seconds).\n"
        started = "Test Case '-[PigeonReaderUITests.StartupUITests testStartsUp]' started.\n"
        failed = "Test Case '-[PigeonReaderUITests.StartupUITests testStartsUp]' failed (4.0 seconds).\n"
        passed2 = "Test Case '-[PigeonReaderUITests.StartupUITests testStartsUp]' passed (2.0 seconds).\n"
        units = "\u2714 Test run with 812 tests in 63 suites passed after 38.200 seconds.\n"
        no_units = "\u2714 Test run with 0 tests in 0 suites passed after 0.001 seconds.\n"
        for body, ok in [
            (units + passed + passed2, True),
            (units + passed + skipped, False),
            (units + passed + started, False),
            (units + passed + failed, False),
            (units + passed, False),
            (passed + passed2, False),
            (no_units + passed + passed2, False),
            ("", False),
        ]:
            with self.subTest(body=body):
                log.write_text(body)
                self.assertEqual(smoke.verify_log(self.list, log)[2] == [], ok)

    def test_repository_smoke_list_is_current(self):
        entries, errors = smoke.check(smoke.DEFAULT_LIST, smoke.DEFAULT_TESTS_DIR)
        self.assertEqual(errors, [])
        self.assertGreater(len(entries), 0)


if __name__ == "__main__":
    unittest.main()
