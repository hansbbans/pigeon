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
const skippedStep = (name) => ({ name, status: "completed", conclusion: "skipped" });
// The native job has one test step per UI suite; the unselected one is skipped.
const fullNativeSteps = [successfulStep("Run unit and full UI tests"), skippedStep("Run unit and smoke UI tests"), successfulStep("Clean Release build")];
const smokeNativeSteps = [skippedStep("Run unit and full UI tests"), successfulStep("Run unit and smoke UI tests"), successfulStep("Clean Release build")];
const ciJobsFor = (runId, nativeSteps = fullNativeSteps) => [
	{ name: "Worker tests, types, and audit", steps: [successfulStep("Run npm run check")] },
	{ name: "iOS tests and clean Release build", steps: nativeSteps },
	{ name: "CI and release tooling fixtures", steps: [successfulStep("Test scope and required gate"), successfulStep("Verify TestFlight release tooling")] },
	{ name: "CI required validation", steps: [successfulStep("Require successful selected validation")] },
	{ name: "Classify validation scope", steps: [successfulStep("Classify complete change range")] },
].map((job) => ({ ...job, head_sha: sha, run_id: runId, run_attempt: 1, status: "completed", conclusion: "success" }));
const jobs = ciJobsFor(run.id);
const smokeJobs = (runId) => ciJobsFor(runId, smokeNativeSteps);
// A nightly that found the commit already proven skips both suites.
const skippedSuiteJobs = (runId) => ciJobsFor(runId).map((job) =>
	["Worker tests, types, and audit", "iOS tests and clean Release build"].includes(job.name) ? { ...job, conclusion: "skipped", steps: [] } : job);

function fixture({ runs = [run], ciJobs = jobs, jobsByRun = {}, current, selectedWorkflow = workflow, runsPages, jobsPages } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(path);
			if (path.endsWith("/workflows/ci.yml")) return selectedWorkflow;
			const page = Number(new URL(`https://example.test${path}`).searchParams.get("page"));
			if (path.includes("/workflows/11/runs?")) return { workflow_runs: runsPages?.[page - 1] ?? runs };
			const jobsMatch = path.match(/\/runs\/(\d+)\/attempts\/1\/jobs\?/);
			if (jobsMatch) return { jobs: jobsPages?.[page - 1] ?? jobsByRun[jobsMatch[1]] ?? ciJobs };
			const runMatch = path.match(/\/runs\/(\d+)$/);
			if (runMatch) return current ?? (runsPages?.flat() ?? runs).find((candidate) => candidate.id === Number(runMatch[1]));
			throw new Error(`Unexpected fixture request: ${path}`);
		},
	};
}

const evaluate = (options = {}) => evaluateCiEvidence({ repository, sha, ...options });

test("reuses an authoritative exact-SHA main run only after all jobs and full-suite test steps succeed", async () => {
	const api = fixture();
	const result = await evaluate(api);
	assert.equal(result.reuseCi, true);
	assert.equal(result.runId, 200);
	assert.ok(api.calls[1].includes(`head_sha=${sha}&branch=main&`));
	assert.ok(api.calls[2].includes("/runs/200/attempts/1/jobs?"));
});

const nightly = { ...run, id: 300, event: "schedule" };
const dispatched = { ...run, id: 400, event: "workflow_dispatch" };

test("a smoke-only main push is not release evidence", async () => {
	const result = await evaluate(fixture({ ciJobs: smokeJobs(run.id) }));
	assert.equal(result.reuseCi, false);
	assert.match(result.reason, /full UI suite/);
	assert.match(result.reason, /Run unit and full UI tests/);
});

test("a pre-split native step name is not full-suite evidence", async () => {
	const legacy = [successfulStep("Run unit and UI tests"), successfulStep("Clean Release build")];
	assert.equal((await evaluate(fixture({ ciJobs: ciJobsFor(run.id, legacy) }))).reuseCi, false);
});

test("a nightly full-suite run is reused past the commit's earlier smoke push", async () => {
	const result = await evaluate(fixture({ runs: [run, nightly], jobsByRun: { 200: smokeJobs(200), 300: ciJobsFor(300) } }));
	assert.equal(result.reuseCi, true);
	assert.equal(result.runId, 300);
	assert.match(result.reason, /schedule run 300/);
});

test("a full-suite workflow_dispatch run is reused and a smoke dispatch is not", async () => {
	const full = await evaluate(fixture({ runs: [run, dispatched], jobsByRun: { 200: smokeJobs(200), 400: ciJobsFor(400) } }));
	assert.equal(full.reuseCi, true);
	assert.equal(full.runId, 400);
	const smoke = await evaluate(fixture({ runs: [run, dispatched], jobsByRun: { 200: smokeJobs(200), 400: smokeJobs(400) } }));
	assert.equal(smoke.reuseCi, false);
});

test("newer green runs without the full suite do not hide an older full-suite nightly", async () => {
	const skippedNightly = { ...run, id: 500, event: "schedule" };
	const smokeDispatch = { ...dispatched, id: 450 };
	const result = await evaluate(fixture({
		runs: [run, nightly, smokeDispatch, skippedNightly],
		jobsByRun: { 200: smokeJobs(200), 300: ciJobsFor(300), 450: smokeJobs(450), 500: skippedSuiteJobs(500) },
	}));
	assert.equal(result.reuseCi, true);
	assert.equal(result.runId, 300);
});

test("a failed run newer than the full-suite nightly falls back", async () => {
	const failedDispatch = { ...dispatched, conclusion: "failure" };
	const result = await evaluate(fixture({ runs: [run, nightly, failedDispatch], jobsByRun: { 200: smokeJobs(200), 300: ciJobsFor(300) } }));
	assert.equal(result.reuseCi, false);
});

test("the nightly check excludes its own in-progress run", async () => {
	const self = { ...run, id: 600, event: "schedule", status: "in_progress", conclusion: null };
	const runs = [run, nightly, self];
	const jobsByRun = { 200: smokeJobs(200), 300: ciJobsFor(300) };
	assert.equal((await evaluate(fixture({ runs, jobsByRun }))).reuseCi, false);
	const result = await evaluate({ ...fixture({ runs, jobsByRun }), excludeRunId: 600 });
	assert.equal(result.reuseCi, true);
	assert.equal(result.runId, 300);
});

test("a commit with only smoke and skipped runs needs a full nightly", async () => {
	const skippedNightly = { ...nightly, id: 500 };
	assert.equal((await evaluate(fixture({ runs: [run, skippedNightly], jobsByRun: { 200: smokeJobs(200), 500: skippedSuiteJobs(500) } }))).reuseCi, false);
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
	"other event": { event: "repository_dispatch" },
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
	for (const ciJobs of [jobs.slice(0, 1), [jobs[0], { ...jobs[1], conclusion: "skipped" }, ...jobs.slice(2)], [...jobs, jobs[1]], [jobs[0], { ...jobs[1], head_sha: "b".repeat(40) }, ...jobs.slice(2)]]) {
		assert.equal((await evaluate(fixture({ ciJobs }))).reuseCi, false);
	}
});

test("missing, skipped, or duplicate full-suite and clean-build steps fall back", async () => {
	for (const steps of [[], [successfulStep("Clean Release build")], [successfulStep("Run unit and full UI tests"), skippedStep("Clean Release build")], [successfulStep("Run unit and full UI tests"), successfulStep("Run unit and full UI tests"), successfulStep("Clean Release build")]]) {
		assert.equal((await evaluate(fixture({ ciJobs: [jobs[0], { ...jobs[1], steps }, ...jobs.slice(2)] }))).reuseCi, false);
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

test("proportional green CI without native proof runs full release tests", async () => {
    const required = jobs[3];
    const scope = jobs[4];
    for (const ciJobs of [
        [scope, jobs[2], required, { ...jobs[0], conclusion: "skipped" }, { ...jobs[1], conclusion: "skipped" }],
        [scope, jobs[2], required, jobs[0], { ...jobs[1], conclusion: "skipped" }],
        [scope, jobs[2], required, jobs[0]],
        [scope, jobs[2], required, jobs[0], { ...jobs[1], steps: [] }],
    ]) {
        assert.equal((await evaluate(fixture({ ciJobs }))).reuseCi, false);
    }
});

test("full proportional CI requires scope, gate, tooling, and real native proof", async () => {
    assert.equal((await evaluate(fixture())).reuseCi, true);
    for (const name of ["CI and release tooling fixtures", "CI required validation", "Classify validation scope"]) {
        assert.equal((await evaluate(fixture({ ciJobs: jobs.filter((job) => job.name !== name) }))).reuseCi, false);
    }
});
