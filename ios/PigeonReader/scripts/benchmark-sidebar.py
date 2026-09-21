#!/usr/bin/env python3
"""Compare the previous sidebar projection with production code, using Swift -O.

This measures CPU work on the host Mac; it does not measure iOS frames or hitches.
"""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
developer = Path(subprocess.check_output(["xcode-select", "-p"], text=True).strip())
compiler = developer / "Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"
sdk = developer / "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
sources = [
    "Core/ReaderNavigationItem.swift", "Core/ReaderNavigationState.swift",
    "Core/ReaderSection.swift", "Core/ReaderSidebarFilter.swift",
    "Features/Reader/ReaderSidebarPresentationState.swift",
    "Features/Reader/ReaderSidebarPresentationProjection.swift",
]
with tempfile.TemporaryDirectory(prefix="pigeon-sidebar-benchmark-") as temporary:
    executable = Path(temporary) / "benchmark"
    subprocess.run([
        str(compiler), "-O", "-whole-module-optimization", "-parse-as-library",
        "-swift-version", "6", "-sdk", str(sdk), "-o", str(executable),
        *[str(root / "PigeonReader" / source) for source in sources],
        str(root / "scripts/SidebarProjectionBenchmark.swift"),
    ], check=True)
    subprocess.run([str(executable)], check=True)
