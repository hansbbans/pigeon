import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyUploadEvidence, loadReceiptWithFallback, parseOptions, receiptFromLogs, runRelease, validateReceipt } from "../scripts/release-new-build-to-testflight.mjs";

const sha = "a".repeat(40);
const requestId = "codex-pigeon-abcdef-1234";
const state = { repository: "hansbbans/pigeon", expected_sha: sha, request_id: requestId };
const run = {
	id: 100, workflow_id: 11, path: ".github/workflows/release-testflight.yml", head_sha: sha,
	head_branch: "main", event: "workflow_dispatch", repository: { full_name: state.repository },
	display_title: `Release Pigeon to TestFlight [${requestId}]`, run_attempt: 1,
	status: "completed", conclusion: "success", html_url: "https://github.com/hansbbans/pigeon/actions/runs/100",
};
const receipt = {
	schema: "testflight-monitor/v1", status: "success", app: "pigeon", repository: state.repository,
	source_sha: sha, request_id: requestId, release_run_id: "100", run_attempt: "1", uploaded: true,
	apple_valid: true, tester_available: true, processing_state: "VALID", bundle_id: "com.hans.pigeon.reader",
	apple_build_id: "build-1", build_number: "101", groups: [{ name: "Pigeon Internal", exact_build_available: true, tester_count: 1 }],
	marketing_version: "1.0", stages: { archive: "success", export: "success", upload: "success", apple_processing: "success", tester_access: "success" },
};
const options = { requestId, resume: false, internalOnly: "true", forceFullTests: false, marketingVersion: "", timeoutSeconds: 5, intervalSeconds: 1 };

function harness({ existingState, runs = [run], completedRun = run, artifact = receipt, dispatchError = false, unreadableArtifact = false, ciJobs = [] } = {}) {
	const calls = [];
	let saved = existingState;
	let clock = 0;
	const dependencies = {
		stateExists: async () => saved !== undefined,
		loadState: async () => saved,
		saveState: async (value, { exclusive = false } = {}) => {
			if (exclusive && saved) throw new Error("State already exists");
			saved = structuredClone(value);
		},
		now: () => clock,
		sleep: async (milliseconds) => { clock += milliseconds; },
		downloadReceipt: async () => { if (unreadableArtifact) throw new Error("No verified receipt"); return artifact; },
		gh: async (args) => {
			calls.push(args);
			if (args[0] === "workflow") {
				assert.ok(saved, "request state must be persisted before any dispatch");
				if (dispatchError) throw new Error("Network response lost after dispatch");
				return "";
			}
			assert.equal(args[0], "api", "tests use injected calls, never the real gh executable");
			const path = args[1];
			if (path.endsWith("/commits/main")) return { sha };
			if (path.endsWith("/workflows/release-testflight.yml")) return { id: 11, path: run.path };
			if (path.includes("/workflows/11/runs?")) return { workflow_runs: runs };
			if (path.endsWith("/runs/100")) return completedRun;
			if (path.includes("/attempts/1/jobs?")) return { jobs: ciJobs };
			throw new Error(`Unexpected mocked gh read: ${path}`);
		},
	};
	return { dependencies, calls, saved: () => saved };
}

test("one dispatch, persisted request, matching run, verified receipt", async () => {
	const mock = harness();
	const result = await runRelease(options, mock.dependencies);
	assert.equal(result.status, "success");
	assert.equal(result.expected_sha, sha);
	assert.equal(mock.calls.filter((args) => args[0] === "workflow").length, 1);
	const dispatch = mock.calls.find((args) => args[0] === "workflow");
	assert.ok(dispatch.includes(`request_id=${requestId}`));
	assert.ok(dispatch.includes(`expected_sha=${sha}`));
	assert.ok(dispatch.includes("force_full_tests=false"));
	assert.equal(mock.saved().status, "success");
});

test("an existing state refuses a second dispatch", async () => {
	const mock = harness({ existingState: state });
	await assert.rejects(runRelease(options, mock.dependencies), /resume-monitor/);
	assert.deepEqual(mock.calls, []);
});

test("resuming a known run performs only reads", async () => {
	const mock = harness({ existingState: { ...state, release_run_id: 100 } });
	assert.equal((await runRelease({ ...options, resume: true }, mock.dependencies)).status, "success");
	assert.ok(mock.calls.every((args) => args[0] === "api"));
});

test("an ambiguous dispatch response recovers its run instead of dispatching again", async () => {
	const mock = harness({ dispatchError: true });
	assert.equal((await runRelease(options, mock.dependencies)).status, "success");
	assert.equal(mock.calls.filter((args) => args[0] === "workflow").length, 1);
});

test("timeout preserves request and run ID without success or redispatch", async () => {
	const mock = harness({ completedRun: { ...run, status: "in_progress", conclusion: null } });
	const result = await runRelease(options, mock.dependencies);
	assert.equal(result.status, "needs_attention");
	assert.equal(result.release_run_id, 100);
	assert.equal(result.request_id, requestId);
	assert.equal(result.apple_valid, null);
	assert.match(result.error, /timed out/);
	assert.equal(mock.calls.filter((args) => args[0] === "workflow").length, 1);
});

test("lost dispatch with no discovered run preserves resumable request", async () => {
	const mock = harness({ dispatchError: true, runs: [] });
	const result = await runRelease(options, mock.dependencies);
	assert.equal(result.status, "needs_attention");
	assert.equal(result.request_id, requestId);
	assert.equal(result.release_run_id, undefined);
	assert.equal(mock.calls.filter((args) => args[0] === "workflow").length, 1);
});

test("main advancing preserves the discovered run ID but rejects the wrong SHA", async () => {
	const mock = harness({ runs: [{ ...run, head_sha: "b".repeat(40) }] });
	const result = await runRelease(options, mock.dependencies);
	assert.equal(result.status, "needs_attention");
	assert.equal(result.release_run_id, 100);
	assert.match(result.error, /exact-commit/);
});

test("duplicate request matches fail without inferring an upload", async () => {
	const mock = harness({ runs: [run, { ...run, id: 101 }] });
	const result = await runRelease(options, mock.dependencies);
	assert.equal(result.status, "needs_attention");
	assert.match(result.error, /Multiple runs/);
});

test("failed workflow or missing receipt cannot report tester-ready success", async () => {
	for (const settings of [{ completedRun: { ...run, conclusion: "failure" } }, { unreadableArtifact: true }]) {
		const mock = harness(settings);
		assert.equal((await runRelease(options, mock.dependencies)).status, "needs_attention");
		assert.equal(mock.calls.filter((args) => args[0] === "workflow").length, 1);
	}
});

test("receipt validates run, attempt, request, SHA and all release stages", () => {
	for (const patch of [{ source_sha: "b".repeat(40) }, { run_attempt: "2" }, { release_run_id: "101" }, { request_id: "other" }, { uploaded: false }, { apple_valid: false }, { tester_available: false }, { processing_state: "PROCESSING" }, { marketing_version: undefined }, { stages: { upload: "success" } }, { groups: [] }, { groups: [{ name: "Pigeon Internal", exact_build_available: false, tester_count: 1 }] }, { groups: [{ name: "Pigeon Internal", exact_build_available: true, tester_count: 0 }] }]) {
		assert.throws(() => validateReceipt({ ...receipt, ...patch }, state, run));
	}
});

test("artifact-quota fallback accepts only one receipt marker from the exact verification step", () => {
	const logs = `Verify App Store Connect build\tVerify exact build and TestFlight group availability\t2026-09-29T12:00:00Z TESTFLIGHT_RECEIPT_JSON:${JSON.stringify(receipt)}\n`;
	assert.equal(validateReceipt(receiptFromLogs(logs), state, run).status, "success");
	assert.throws(() => receiptFromLogs(logs + logs));
	assert.throws(() => receiptFromLogs(logs.replace("Verify exact build and TestFlight group availability", "Run Pigeon tests")));
	assert.throws(() => receiptFromLogs("no receipt"));
});

test("artifact quota recovery reads only the exact attempt's successful verifier job", async () => {
	const calls = [];
	const verifier = { id: 55, name: "Verify App Store Connect build", head_sha: sha, run_id: 100, run_attempt: 1, status: "completed", conclusion: "success" };
	const loaded = await loadReceiptWithFallback(run, {
		artifactReceipt: async () => { throw new Error("Artifact storage quota"); },
		gh: async (args) => {
			calls.push(args);
			if (args[0] === "api") return { jobs: [verifier] };
			assert.ok(args.includes("--job"));
			assert.ok(args.includes("55"));
			assert.ok(args.includes("--attempt"));
			return `Verify App Store Connect build\tVerify exact build and TestFlight group availability\t2026-09-29T12:00:00Z TESTFLIGHT_RECEIPT_JSON:${JSON.stringify(receipt)}`;
		},
	});
	assert.equal(validateReceipt(loaded, state, run).status, "success");
	assert.equal(calls.length, 2);
	await assert.rejects(loadReceiptWithFallback(run, {
		artifactReceipt: async () => { throw new Error("Artifact unavailable"); },
		gh: async () => ({ jobs: [{ ...verifier, run_attempt: 2 }] }),
	}), /verification job is unavailable/);
});

test("CLI validates required persistent state, bounds, and distinct receipt path", () => {
	assert.throws(() => parseOptions([]));
	assert.throws(() => parseOptions(["--monitor-state", "state.json", "--interval", "0"]));
	assert.throws(() => parseOptions(["--monitor-state", "state.json", "--monitor-receipt", "state.json"]));
	assert.throws(() => parseOptions(["--monitor-state", "state.json", "--internal-only", "no"]));
	assert.throws(() => parseOptions(["--resume-monitor", "state.json", "--force-full-tests"]));
	assert.throws(() => parseOptions(["--resume-monitor", "state.json", "--monitor-state", "other.json"]));
	assert.throws(() => parseOptions(["--monitor-state", "other.json", "--resume-monitor", "state.json"]));
	const parsed = parseOptions(["--resume-monitor", "state.json"]);
	assert.equal(parsed.resume, true);
	assert.equal(parsed.forceFullTests, false);
	assert.equal(parsed.receiptPath, "state.json.receipt.json");
});

test("failed verification preserves proven archive/export/upload stages", async () => {
	const ciJobs = [{ name: "Build and upload", head_sha: sha, run_id: 100, run_attempt: 1, steps: [
		{ name: "Archive release build", conclusion: "success" }, { name: "Upload archive to TestFlight", conclusion: "success" },
	] }];
	const mock = harness({ ciJobs, completedRun: { ...run, conclusion: "failure" } });
	const result = await runRelease(options, mock.dependencies);
	assert.equal(result.status, "needs_attention");
	assert.equal(result.uploaded, true);
	assert.equal(result.stages.archive, "success");
	assert.equal(result.stages.export, "success");
	assert.equal(result.stages.upload, "success");
	assert.equal(result.apple_valid, null);
});

test("wrong-attempt/SHA jobs cannot prove an upload, and upload failure stays unknown", () => {
	const initial = { ...state, uploaded: null, stages: { upload: "unknown" } };
	const job = { name: "Build and upload", head_sha: sha, run_id: 100, run_attempt: 1, steps: [{ name: "Upload archive to TestFlight", conclusion: "success" }] };
	assert.equal(applyUploadEvidence(initial, [{ ...job, head_sha: "b".repeat(40) }], run).uploaded, null);
	assert.equal(applyUploadEvidence(initial, [{ ...job, run_attempt: 2 }], run).uploaded, null);
	assert.equal(applyUploadEvidence(initial, [{ ...job, steps: [{ name: "Upload archive to TestFlight", conclusion: "failure" }] }], run).uploaded, null);
	assert.equal(applyUploadEvidence(initial, [{ ...job, steps: [{ name: "Upload archive to TestFlight", conclusion: "skipped" }] }], run).uploaded, false);
});

test("actual shell guard stops pre-dispatch and checkout races before release work", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pigeon-commit-guard-test-"));
	const execute = promisify(execFile);
	try {
		await writeFile(join(directory, "git"), '#!/usr/bin/env bash\n[[ "$*" == "rev-parse HEAD" ]] || exit 1\nprintf "%s\\n" "$FIXTURE_CHECKOUT_SHA"\n', { mode: 0o700 });
		const check = (expected, dispatched = sha, checkedOut = sha) => execute("bash", ["scripts/require-testflight-commit.sh"], {
			env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, EXPECTED_RELEASE_SHA: expected, GITHUB_SHA: dispatched, FIXTURE_CHECKOUT_SHA: checkedOut },
		});
		await check(sha);
		await check(""); // Manual workflow dispatch retains its existing exact-checkout behavior.
		await assert.rejects(check("short"), /full lowercase commit SHA/);
		await assert.rejects(check(sha, "b".repeat(40), "b".repeat(40)), /main advanced before dispatch/);
		await assert.rejects(check(sha, sha, "b".repeat(40)), /between dispatch and checkout/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
