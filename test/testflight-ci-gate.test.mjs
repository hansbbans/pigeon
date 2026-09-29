import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCiEvidence } from "../scripts/testflight-ci-gate.mjs";

const repository = "hansbbans/pigeon";
const sha = "a".repeat(40);
const workflow = { id: 11, path: ".github/workflows/ci.yml" };
const run = {
	id: 200, workflow_id: workflow.id, path: workflow.path, head_sha: sha,
	head_branch: "main", event: "push", repository: { full_name: repository },
	head_repository: { full_name: repository }, run_attempt: 1,
	status: "completed", conclusion: "success",
};
const successfulStep = (name) => ({ name, status: "completed", conclusion: "success" });
const jobs = [
	{ name: "Worker tests, types, and audit", steps: [successfulStep("Run npm run check"), successfulStep("Verify TestFlight release tooling")] },
	{ name: "iOS tests and clean Release build", steps: [successfulStep("Run unit and UI tests"), successfulStep("Clean Release build")] },
].map((job) => ({ ...job, head_sha: sha, run_id: run.id, run_attempt: 1, status: "completed", conclusion: "success" }));

function fixture({ runs = [run], ciJobs = jobs, current = run, selectedWorkflow = workflow, runsPages, jobsPages } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(path);
			if (path.endsWith("/workflows/ci.yml")) return selectedWorkflow;
			const page = Number(new URL(`https://example.test${path}`).searchParams.get("page"));
			if (path.includes("/workflows/11/runs?")) return { workflow_runs: runsPages?.[page - 1] ?? runs };
			if (path.includes("/attempts/1/jobs?")) return { jobs: jobsPages?.[page - 1] ?? ciJobs };
			if (path.endsWith("/runs/200")) return current;
			throw new Error(`Unexpected fixture request: ${path}`);
		},
	};
}

const evaluate = (options = {}) => evaluateCiEvidence({ repository, sha, ...options });

test("reuses the authoritative exact-SHA main push only after all jobs and test steps succeed", async () => {
	const api = fixture();
	const result = await evaluate(api);
	assert.equal(result.reuseCi, true);
	assert.equal(result.runId, 200);
	assert.ok(api.calls[1].includes(`head_sha=${sha}&branch=main&event=push`));
	assert.ok(api.calls[2].includes("/attempts/1/jobs?"));
});

test("force-full-tests bypasses every GitHub read", async () => {
	const api = fixture();
	assert.equal((await evaluate({ ...api, forceFullTests: true })).reuseCi, false);
	assert.deepEqual(api.calls, []);
});

for (const [label, change] of Object.entries({
	"wrong SHA": { head_sha: "b".repeat(40) },
	"feature branch": { head_branch: "codex/feature" },
	"PR head": { event: "pull_request" },
	"manual CI": { event: "workflow_dispatch" },
	"other workflow": { workflow_id: 99 },
	"other workflow path": { path: ".github/workflows/other.yml" },
	"fork head": { head_repository: { full_name: "someone/pigeon" } },
	"other repository": { repository: { full_name: "hansbbans/other" } },
	"missing attempt": { run_attempt: undefined },
})) {
	test(`does not trust ${label}`, async () => {
		assert.equal((await evaluate(fixture({ runs: [{ ...run, ...change }] }))).reuseCi, false);
	});
}

for (const [status, conclusion] of [["queued", null], ["in_progress", null], ["completed", "failure"], ["completed", "cancelled"], ["completed", "skipped"], ["completed", "timed_out"]]) {
	test(`latest ${status}/${conclusion} falls back instead of reusing an older success`, async () => {
		const latest = { ...run, id: 201, status, conclusion };
		assert.equal((await evaluate(fixture({ runs: [run, latest] }))).reuseCi, false);
	});
}

test("missing CI falls back", async () => {
	assert.equal((await evaluate(fixture({ runs: [] }))).reuseCi, false);
});

test("missing, skipped, duplicate, or wrong-SHA native jobs fall back", async () => {
	for (const ciJobs of [jobs.slice(0, 1), [jobs[0], { ...jobs[1], conclusion: "skipped" }], [...jobs, jobs[1]], [jobs[0], { ...jobs[1], head_sha: "b".repeat(40) }]]) {
		assert.equal((await evaluate(fixture({ ciJobs }))).reuseCi, false);
	}
});

test("missing or skipped unit/UI and clean-build steps fall back", async () => {
	for (const steps of [[], [successfulStep("Clean Release build")], [successfulStep("Run unit and UI tests"), { ...successfulStep("Clean Release build"), conclusion: "skipped" }]]) {
		assert.equal((await evaluate(fixture({ ciJobs: [jobs[0], { ...jobs[1], steps }] }))).reuseCi, false);
	}
});

test("a newer rerun during evidence reads falls back", async () => {
	assert.equal((await evaluate(fixture({ current: { ...run, run_attempt: 2, status: "in_progress", conclusion: null } }))).reuseCi, false);
});

test("unreadable workflow/jobs fail closed to full tests", async () => {
	assert.equal((await evaluate({ get: async () => { throw new Error("HTTP 403"); } })).reuseCi, false);
	assert.equal((await evaluate(fixture({ selectedWorkflow: { id: 11, path: "wrong" } }))).reuseCi, false);
});

test("run pagination is exhausted before selecting newest trusted evidence", async () => {
	const ignored = Array.from({ length: 100 }, (_, id) => ({ ...run, id: 300 + id, event: "pull_request" }));
	const api = fixture({ runsPages: [ignored, [run]] });
	assert.equal((await evaluate(api)).reuseCi, true);
	assert.ok(api.calls.some((path) => path.includes("/runs?") && path.endsWith("page=2")));
});

test("job pagination includes required jobs on the second page", async () => {
	const extra = Array.from({ length: 100 }, (_, id) => ({ name: `extra-${id}`, status: "completed", conclusion: "success" }));
	const api = fixture({ jobsPages: [extra, jobs] });
	assert.equal((await evaluate(api)).reuseCi, true);
	assert.ok(api.calls.some((path) => path.includes("/jobs?") && path.endsWith("page=2")));
});

test("bounded pagination exhaustion falls back", async () => {
	const many = Array.from({ length: 100 }, () => run);
	assert.equal((await evaluate(fixture({ runs: many }))).reuseCi, false);
});
