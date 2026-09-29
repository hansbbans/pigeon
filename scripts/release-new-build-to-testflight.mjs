import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const REPOSITORY = "hansbbans/pigeon";
const WORKFLOW = ".github/workflows/release-testflight.yml";
const exec = promisify(execFile);

export function receiptFromLogs(logs) {
	const lines = logs.split("\n").filter((line) => line.includes("\tVerify exact build and TestFlight group availability\t") && /TESTFLIGHT_RECEIPT_JSON:\{/.test(line));
	if (lines.length !== 1) throw new Error("Exact verification job did not emit one authoritative release receipt.");
	return JSON.parse(lines[0].slice(lines[0].indexOf("TESTFLIGHT_RECEIPT_JSON:") + "TESTFLIGHT_RECEIPT_JSON:".length));
}

export async function loadReceiptWithFallback(run, { artifactReceipt, gh }) {
	try {
		return await artifactReceipt();
	} catch {
		// Artifact quota/retention must not turn verified access into an upload
		// retry. Read only this attempt's small successful verification job.
		const payload = await gh(["api", `repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`]);
		const jobs = payload.jobs?.filter((job) => job.name === "Verify App Store Connect build" && job.head_sha === run.head_sha &&
			job.run_id === run.id && job.run_attempt === run.run_attempt && job.status === "completed" && job.conclusion === "success") ?? [];
		if (jobs.length !== 1) throw new Error("Exact successful verification job is unavailable.");
		return receiptFromLogs(await gh(["run", "view", String(run.id), "--repo", REPOSITORY, "--attempt", String(run.run_attempt), "--job", String(jobs[0].id), "--log"], { json: false }));
	}
}

export function validateReceipt(receipt, state, run) {
	if (receipt.schema !== "testflight-monitor/v1" || receipt.status !== "success" || receipt.app !== "pigeon" ||
		receipt.repository !== REPOSITORY || receipt.source_sha !== state.expected_sha ||
		String(receipt.release_run_id) !== String(run.id) || String(receipt.run_attempt) !== String(run.run_attempt) ||
		receipt.request_id !== state.request_id || receipt.uploaded !== true ||
		receipt.apple_valid !== true || receipt.processing_state !== "VALID" || receipt.tester_available !== true ||
		receipt.bundle_id !== "com.hans.pigeon.reader" || !receipt.apple_build_id || !receipt.build_number ||
		!/^\d+(\.\d+){0,2}$/.test(receipt.marketing_version ?? "") ||
		!["archive", "export", "upload", "apple_processing", "tester_access"].every((stage) => receipt.stages?.[stage] === "success") ||
		!Array.isArray(receipt.groups) || receipt.groups.length < 1 ||
		!receipt.groups.some((group) => group.name === "Pigeon Internal") ||
		receipt.groups.some((group) => group.exact_build_available !== true || !Number.isSafeInteger(group.tester_count) || group.tester_count < 1)) {
		throw new Error("Verification artifact does not prove this exact release, VALID processing, and tester access.");
	}
	return { ...receipt, expected_sha: state.expected_sha, release_run_url: run.html_url };
}

export function applyUploadEvidence(state, jobs, run) {
	const matches = jobs.filter((job) => job.name === "Build and upload" && job.head_sha === state.expected_sha &&
		job.run_id === run.id && job.run_attempt === run.run_attempt);
	if (matches.length !== 1) return state;
	const job = matches[0];
	const step = (name) => {
		const matchesSteps = job.steps?.filter((value) => value.name === name) ?? [];
		return matchesSteps.length === 1 ? matchesSteps[0] : undefined;
	};
	const archive = step("Archive release build");
	const upload = step("Upload archive to TestFlight");
	const stages = { ...state.stages };
	if (archive?.conclusion === "success") stages.archive = "success";
	// Export and upload are one xcodebuild step. Its failure may occur after
	// acceptance, so only success proves an upload; failure remains unknown.
	if (upload?.conclusion === "success") {
		stages.export = "success";
		stages.upload = "success";
		return { ...state, uploaded: true, stages, upload_run_attempt: run.run_attempt };
	}
	if (upload?.conclusion === "skipped" && state.uploaded !== true) {
		stages.export = "skipped";
		stages.upload = "skipped";
		return { ...state, uploaded: false, stages };
	}
	return { ...state, stages };
}

function checkRun(run, state, workflowId) {
	if (run.head_sha !== state.expected_sha || run.head_branch !== "main" || run.event !== "workflow_dispatch" ||
		run.workflow_id !== workflowId || run.path !== WORKFLOW || run.repository?.full_name !== REPOSITORY ||
		!run.display_title?.endsWith(`[${state.request_id}]`)) {
		throw new Error("Identified workflow run does not match the saved exact-commit release request.");
	}
}

// All routine waits stay inside this script. Never dispatch again after an
// uncertain response: persist the request first and recover it by request ID.
export async function runRelease(options, dependencies) {
	const { gh, loadState, saveState, stateExists, downloadReceipt, sleep, now } = dependencies;
	let state;
	if (options.resume) {
		state = await loadState();
		if (state.repository !== REPOSITORY || !/^[a-f0-9]{40}$/.test(state.expected_sha ?? "") || !/^codex-pigeon-[a-f0-9-]+$/.test(state.request_id ?? "")) {
			throw new Error("Saved release request has invalid provenance.");
		}
	} else {
		if (await stateExists()) throw new Error("Monitor state already exists; use --resume-monitor instead of dispatching again.");
		const commit = await gh(["api", `repos/${REPOSITORY}/commits/main`]);
		if (!/^[a-f0-9]{40}$/.test(commit.sha ?? "")) throw new Error("Cannot resolve an exact remote main commit.");
		state = { schema: "testflight-monitor/v1", app: "pigeon", repository: REPOSITORY, expected_sha: commit.sha,
			request_id: options.requestId, status: "dispatching", uploaded: null, apple_valid: null, tester_available: null,
			stages: { archive: "unknown", export: "unknown", upload: "unknown", apple_processing: "unknown", tester_access: "unknown" } };
		await saveState(state, { exclusive: true });
		const inputs = { request_id: state.request_id, expected_sha: state.expected_sha, internal_only: options.internalOnly, force_full_tests: options.forceFullTests, marketing_version: options.marketingVersion };
		try {
			await gh(["workflow", "run", "release-testflight.yml", "--repo", REPOSITORY, "--ref", "main", ...Object.entries(inputs).flatMap(([key, value]) => ["-f", `${key}=${value}`])], { json: false });
			state.status = "dispatched";
		} catch {
			state.status = "dispatch_unknown";
		}
		await saveState(state);
	}
	const deadline = now() + options.timeoutSeconds * 1000;
	try {
		const workflow = await gh(["api", `repos/${REPOSITORY}/actions/workflows/release-testflight.yml`]);
		if (workflow.path !== WORKFLOW || !Number.isSafeInteger(workflow.id)) throw new Error("Release workflow identity is unavailable.");
		while (now() < deadline) {
			if (!state.release_run_id) {
				const matches = [];
				// Recover by unique request ID, including a main-advance race. Such a
				// run is identified and reported, but never accepted as the intended SHA.
				for (let page = 1; page <= 10; page += 1) {
					const payload = await gh(["api", `repos/${REPOSITORY}/actions/workflows/${workflow.id}/runs?branch=main&event=workflow_dispatch&per_page=100&page=${page}`]);
					if (!Array.isArray(payload.workflow_runs)) throw new Error("Malformed release-run response.");
					matches.push(...payload.workflow_runs.filter((run) => run.display_title?.endsWith(`[${state.request_id}]`)));
					if (payload.workflow_runs.length < 100) break;
					if (page === 10) throw new Error("Release-run recovery exceeded its bounded history limit.");
				}
				if (matches.length > 1) throw new Error("Multiple runs match this request; refusing to infer which upload succeeded.");
				if (matches.length === 1) {
					state.release_run_id = matches[0].id;
					state.release_run_url = matches[0].html_url;
					await saveState(state);
					checkRun(matches[0], state, workflow.id);
				}
			}
			if (state.release_run_id) {
				const run = await gh(["api", `repos/${REPOSITORY}/actions/runs/${state.release_run_id}`]);
				checkRun(run, state, workflow.id);
				state.run_attempt = run.run_attempt;
				state.status = run.status;
				try {
					const jobs = await gh(["api", `repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`]);
					if (Array.isArray(jobs.jobs)) state = applyUploadEvidence(state, jobs.jobs, run);
				} catch {
					// Unavailable stage reads remain unknown; they never trigger a
					// dispatch or weaken the final verification-receipt requirement.
				}
				await saveState(state);
				if (run.status === "completed") {
					if (run.conclusion !== "success") throw new Error(`Workflow completed with ${run.conclusion}; resume after any verification-only retry. Do not automatically re-upload.`);
					const receipt = validateReceipt(await downloadReceipt(run), state, run);
					await saveState({ ...state, ...receipt });
					return receipt;
				}
			}
			await sleep(Math.min(options.intervalSeconds * 1000, Math.max(0, deadline - now())));
		}
		throw new Error("Monitoring timed out; resume the saved request without another dispatch.");
	} catch (error) {
		const result = { ...state, status: "needs_attention", error: error.message };
		await saveState(result);
		return result;
	}
}

export function parseOptions(args) {
	const options = { resume: false, forceFullTests: false, internalOnly: "true", marketingVersion: "", timeoutSeconds: 7200, intervalSeconds: 30 };
	const seen = new Set();
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}.`);
		seen.add(arg);
		if (arg === "--force-full-tests") options.forceFullTests = true;
		else if (arg === "--resume-monitor" || arg === "--monitor-state" || arg === "--monitor-receipt" || arg === "--timeout" || arg === "--interval" || arg === "--marketing-version" || arg === "--internal-only") {
			const value = args[++i];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
			if (arg === "--resume-monitor") { options.resume = true; options.statePath = value; }
			if (arg === "--monitor-state") options.statePath = value;
			if (arg === "--monitor-receipt") options.receiptPath = value;
			if (arg === "--timeout") options.timeoutSeconds = Number(value);
			if (arg === "--interval") options.intervalSeconds = Number(value);
			if (arg === "--marketing-version") options.marketingVersion = value;
			if (arg === "--internal-only") options.internalOnly = value;
		} else throw new Error(`Unknown option: ${arg}.`);
	}
	if (!options.statePath) throw new Error("Supply --monitor-state FILE for a new release or --resume-monitor FILE to continue one.");
	if (options.resume && ["--monitor-state", "--force-full-tests", "--marketing-version", "--internal-only"].some((arg) => seen.has(arg))) {
		throw new Error("Resume cannot change a saved release request or specify new dispatch options.");
	}
	for (const key of ["timeoutSeconds", "intervalSeconds"]) if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`${key} must be positive.`);
	if (!["true", "false"].includes(options.internalOnly)) throw new Error("--internal-only must be true or false.");
	if (options.marketingVersion && !/^\d+(\.\d+){0,2}$/.test(options.marketingVersion)) throw new Error("Invalid marketing version.");
	options.receiptPath ??= `${options.statePath}.receipt.json`;
	if (resolve(options.receiptPath) === resolve(options.statePath)) throw new Error("State and receipt paths must differ.");
	options.requestId = `codex-pigeon-${randomUUID()}`;
	return options;
}

async function main() {
	try {
		const options = parseOptions(process.argv.slice(2));
		const gh = async (args, { json = true } = {}) => {
			const { stdout } = await exec("gh", args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
			return json ? JSON.parse(stdout) : stdout;
		};
		const saveState = async (state, { exclusive = false } = {}) => {
			if (exclusive) {
				await writeFile(options.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
				return;
			}
			const temporary = `${options.statePath}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
			await rename(temporary, options.statePath);
		};
		console.error(`Monitoring state: ${resolve(options.statePath)}`);
		const receipt = await runRelease(options, {
			gh, saveState,
			loadState: async () => JSON.parse(await readFile(options.statePath, "utf8")),
			stateExists: async () => { try { await access(options.statePath); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } },
			now: Date.now, sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
			downloadReceipt: async (run) => {
				const directory = await mkdtemp(join(tmpdir(), "pigeon-receipt-"));
				try {
					return await loadReceiptWithFallback(run, { gh, artifactReceipt: async () => {
						await gh(["run", "download", String(run.id), "--repo", REPOSITORY, "--name", `pigeon-testflight-receipt-${run.id}-${run.run_attempt}`, "--dir", directory], { json: false });
						return JSON.parse(await readFile(join(directory, `pigeon-testflight-receipt-${run.id}-${run.run_attempt}.json`), "utf8"));
					} });
				} finally { await rm(directory, { recursive: true, force: true }); }
			},
		});
		await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		console.log(JSON.stringify(receipt));
		if (receipt.status !== "success") process.exitCode = 1;
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
