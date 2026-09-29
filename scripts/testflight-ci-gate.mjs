import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_STEPS = {
	"Worker tests, types, and audit": ["Run npm run check", "Verify TestFlight release tooling"],
	"iOS tests and clean Release build": ["Run unit and UI tests", "Clean Release build"],
};

// Only this repository's push-to-main CI can replace release tests. A PR run
// (including its synthetic merge commit), another workflow, or partial success cannot.
export async function evaluateCiEvidence({ repository, sha, forceFullTests = false, get }) {
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
		const runs = [];
		for (let page = 1; ; page += 1) {
			if (page > 10) return fallback("CI run pagination exceeded the bounded evidence limit.");
			const payload = await get(`${root}/workflows/${workflow.id}/runs?head_sha=${sha}&branch=main&event=push&per_page=100&page=${page}`);
			if (!Array.isArray(payload.workflow_runs)) throw new Error("Malformed CI run response.");
			runs.push(...payload.workflow_runs);
			if (payload.workflow_runs.length < 100) break;
		}
		const trusted = runs.filter((run) =>
			run.workflow_id === workflow.id && run.path === workflow.path &&
			run.head_sha === sha && run.head_branch === "main" && run.event === "push" &&
			run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
			Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
		).sort((a, b) => b.id - a.id);
		const run = trusted[0];
		if (!run) return fallback("No authoritative main-push CI run exists for this exact commit.");
		if (run.status !== "completed" || run.conclusion !== "success") {
			return fallback(`Latest exact-commit CI run ${run.id} is ${run.status}/${run.conclusion ?? "pending"}.`);
		}
		const jobs = [];
		for (let page = 1; ; page += 1) {
			if (page > 10) return fallback("CI job pagination exceeded the bounded evidence limit.");
			const payload = await get(`${root}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
			if (!Array.isArray(payload.jobs)) throw new Error("Malformed CI job response.");
			jobs.push(...payload.jobs);
			if (payload.jobs.length < 100) break;
		}
		if (jobs.some((job) => job.status !== "completed" || job.conclusion !== "success")) {
			return fallback("CI contains an incomplete, skipped, or unsuccessful job.");
		}
		for (const [name, steps] of Object.entries(REQUIRED_STEPS)) {
			const matches = jobs.filter((job) => job.name === name);
			if (matches.length !== 1 || matches[0].head_sha !== sha || matches[0].run_id !== run.id || matches[0].run_attempt !== run.run_attempt) {
				return fallback(`Missing or ambiguous exact-commit CI job: ${name}.`);
			}
			for (const stepName of steps) {
				const matchesSteps = matches[0].steps?.filter((step) => step.name === stepName) ?? [];
				if (matchesSteps.length !== 1 || matchesSteps[0].status !== "completed" || matchesSteps[0].conclusion !== "success") {
					return fallback(`Required CI step did not succeed: ${stepName}.`);
				}
			}
		}
		// A concurrent rerun must not let a now-stale successful attempt through.
		const current = await get(`${root}/runs/${run.id}`);
		if (current.run_attempt !== run.run_attempt || current.status !== "completed" || current.conclusion !== "success" || current.head_sha !== sha) {
			return fallback("CI changed while evidence was being checked.");
		}
		return { reuseCi: true, reason: `Exact main commit passed all CI jobs and required test/build steps in run ${run.id}, attempt ${run.run_attempt}.`, runId: run.id, runAttempt: run.run_attempt };
	} catch (error) {
		return fallback(`CI evidence could not be verified; running full release tests (${error.message}).`);
	}
}

async function main() {
	const result = await evaluateCiEvidence({
		repository: process.env.GITHUB_REPOSITORY ?? "",
		sha: process.env.GITHUB_SHA ?? "",
		forceFullTests: process.env.FORCE_FULL_TESTS === "true",
		get: async (path) => {
			const response = await fetch(`https://api.github.com${path}`, {
				headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) throw new Error(`GitHub read returned HTTP ${response.status}`);
			return response.json();
		},
	});
	await appendFile(process.env.GITHUB_OUTPUT, `reuse_ci=${result.reuseCi}\nci_run_id=${result.runId ?? ""}\nci_run_attempt=${result.runAttempt ?? ""}\n`);
	await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Release test evidence\n\n${result.reason}\n\nMode: ${result.reuseCi ? "reuse exact-commit CI" : "full release tests"}.\n`);
	console.log(JSON.stringify(result));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
