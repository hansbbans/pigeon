import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Only a CI run that executed the FULL UI suite for this exact main commit can
// replace release tests. PR and main-push runs execute the smoke UI subset, so
// their "Run unit and smoke UI tests" step never qualifies; nightly and
// full-suite workflow_dispatch runs execute "Run unit and full UI tests".
export const FULL_SUITE_STEP = "Run unit and full UI tests";
const REQUIRED_STEPS = {
	"Classify validation scope": ["Classify complete change range"],
	"CI required validation": ["Require successful selected validation"],
	"Worker tests, types, and audit": ["Run npm run check"],
	"CI and release tooling fixtures": ["Test scope and required gate", "Verify TestFlight release tooling"],
	"iOS tests and clean Release build": [FULL_SUITE_STEP, "Clean Release build"],
};
// Events whose runs build this repository's main branch. A PR run (including its
// synthetic merge commit) or another workflow never counts.
const MAIN_EVENTS = new Set(["push", "schedule", "workflow_dispatch"]);
const MAX_CANDIDATE_RUNS = 20;

async function readPages(get, path, key) {
	const items = [];
	for (let page = 1; ; page += 1) {
		if (page > 10) return null;
		const payload = await get(`${path}&per_page=100&page=${page}`);
		if (!Array.isArray(payload[key])) throw new Error(`Malformed CI ${key} response.`);
		items.push(...payload[key]);
		if (payload[key].length < 100) return items;
	}
}

// Returns null when the attempt proves a successful full-suite run, otherwise
// the reason it does not. A skipped native job (proportional CI) or a smoke-only
// native run is not full-suite proof.
function fullSuiteGap(run, jobs, sha) {
	if (jobs.some((job) => job.status !== "completed" || job.conclusion !== "success")) {
		return "it contains an incomplete, skipped, or unsuccessful job";
	}
	for (const [name, steps] of Object.entries(REQUIRED_STEPS)) {
		const matches = jobs.filter((job) => job.name === name);
		if (matches.length !== 1 || matches[0].head_sha !== sha || matches[0].run_id !== run.id || matches[0].run_attempt !== run.run_attempt) {
			return `it has no single exact-commit job named ${name}`;
		}
		for (const stepName of steps) {
			const matchesSteps = matches[0].steps?.filter((step) => step.name === stepName) ?? [];
			if (matchesSteps.length !== 1 || matchesSteps[0].status !== "completed" || matchesSteps[0].conclusion !== "success") {
				return `required step did not succeed: ${stepName}`;
			}
		}
	}
	return null;
}

// excludeRunId lets a run ask whether an earlier run already proved this commit.
export async function evaluateCiEvidence({ repository, sha, forceFullTests = false, get, excludeRunId = null }) {
	const fallback = (reason) => ({ reuseCi: false, reason });
	if (forceFullTests) return fallback("Full release tests explicitly requested.");
	if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) {
		return fallback("Invalid repository or exact commit identity.");
	}
	try {
		const root = `/repos/${repository}/actions`;
		const workflow = await get(`${root}/workflows/ci.yml`);
		if (workflow.path !== ".github/workflows/ci.yml" || !Number.isSafeInteger(workflow.id)) {
			return fallback("Authoritative CI workflow identity is unavailable.");
		}
		const runs = await readPages(get, `${root}/workflows/${workflow.id}/runs?head_sha=${sha}&branch=main`, "workflow_runs");
		if (!runs) return fallback("CI run pagination exceeded the bounded evidence limit.");
		const trusted = runs.filter((run) =>
			run.workflow_id === workflow.id && run.path === workflow.path &&
			run.head_sha === sha && run.head_branch === "main" && MAIN_EVENTS.has(run.event) &&
			run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
			Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
			run.id !== excludeRunId
		).sort((a, b) => b.id - a.id);
		if (!trusted.length) return fallback("No authoritative main CI run exists for this exact commit.");
		// Walk newest first. Green runs that did not execute the full suite (smoke
		// pushes, skipped nightlies) are passed over; any run that is not green
		// stops the walk, so a newer failure is never hidden by an older success.
		const gaps = [];
		for (const run of trusted.slice(0, MAX_CANDIDATE_RUNS)) {
			if (run.status !== "completed" || run.conclusion !== "success") {
				return fallback(`Exact-commit CI run ${run.id} is ${run.status}/${run.conclusion ?? "pending"} and no newer run proved the full suite.`);
			}
			const jobs = await readPages(get, `${root}/runs/${run.id}/attempts/${run.run_attempt}/jobs?`, "jobs");
			if (!jobs) return fallback("CI job pagination exceeded the bounded evidence limit.");
			const gap = fullSuiteGap(run, jobs, sha);
			if (gap) {
				gaps.push(`run ${run.id} (${run.event}): ${gap}`);
				continue;
			}
			// A concurrent rerun must not let a now-stale successful attempt through.
			const current = await get(`${root}/runs/${run.id}`);
			if (current.run_attempt !== run.run_attempt || current.status !== "completed" || current.conclusion !== "success" || current.head_sha !== sha) {
				return fallback("CI changed while evidence was being checked.");
			}
			return { reuseCi: true, reason: `Exact main commit passed all CI jobs and the full unit/UI suite and Release build in ${run.event} run ${run.id}, attempt ${run.run_attempt}.`, runId: run.id, runAttempt: run.run_attempt };
		}
		return fallback(`No exact-commit CI run executed the full UI suite (${gaps.join("; ") || "too many runs to inspect"}).`);
	} catch (error) {
		return fallback(`CI evidence could not be verified; running full release tests (${error.message}).`);
	}
}

// Default mode: the release workflow's reuse decision (reuse_ci output).
// --full-suite-exists: the nightly CI scope check, run inside a CI run that must
// not count itself; it reports whether an earlier run already proved this commit.
async function main() {
	const nightly = process.argv.includes("--full-suite-exists");
	const excludeRunId = Number(process.env.GITHUB_RUN_ID);
	const result = await evaluateCiEvidence({
		repository: process.env.GITHUB_REPOSITORY ?? "",
		sha: process.env.GITHUB_SHA ?? "",
		forceFullTests: !nightly && process.env.FORCE_FULL_TESTS === "true",
		excludeRunId: nightly && Number.isSafeInteger(excludeRunId) ? excludeRunId : null,
		get: async (path) => {
			const response = await fetch(`https://api.github.com${path}`, {
				headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) throw new Error(`GitHub read returned HTTP ${response.status}`);
			return response.json();
		},
	});
	if (nightly) {
		await appendFile(process.env.GITHUB_OUTPUT, `full_suite_exists=${result.reuseCi}\n`);
		await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Nightly full suite\n\n${result.reason}\n\nMode: ${result.reuseCi ? "skip: this main commit already passed the full suite" : "run the full suite"}.\n`);
	} else {
		await appendFile(process.env.GITHUB_OUTPUT, `reuse_ci=${result.reuseCi}\nci_run_id=${result.runId ?? ""}\nci_run_attempt=${result.runAttempt ?? ""}\n`);
		await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Release test evidence\n\n${result.reason}\n\nMode: ${result.reuseCi ? "reuse exact-commit CI" : "full release tests"}.\n`);
	}
	console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
