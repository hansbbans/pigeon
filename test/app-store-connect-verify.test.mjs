import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
	AppStoreConnectApiError,
	AppStoreConnectClient,
	formatVerificationSummary,
	verifyTestFlightBuild,
} from "../scripts/app-store-connect-verify.mjs";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });

function response(payload, status = 200, headers = {}) {
	const statusText = status === 204 ? "No Content" : status >= 400 ? "Error" : "OK";
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		headers: {
			get(name) {
				return headers[name.toLowerCase()] ?? null;
			},
		},
		text: async () => (payload === undefined ? "" : JSON.stringify(payload)),
	};
}

function appPage() {
	return {
		data: [
			{
				type: "apps",
				id: "app-1",
				attributes: { name: "Pigeon", bundleId: "com.hans.pigeon.reader" },
			},
		],
	};
}

function build(id = "build-1", version = "456", processingState = "VALID") {
	return { type: "builds", id, attributes: { version, processingState } };
}

function group({ allBuilds = false } = {}) {
	return {
		type: "betaGroups",
		id: "group-1",
		attributes: { name: "Pigeon Internal", hasAccessToAllBuilds: allBuilds },
	};
}

function queuedFetch(responses) {
	const calls = [];
	const fetchImpl = async (input, init) => {
		const url = new URL(input);
		calls.push({ url, init });
		const next = responses.shift();
		if (!next) throw new Error(`No mocked response for ${init.method} ${url.pathname}`);
		return typeof next === "function" ? next({ url, init, calls }) : next;
	};
	return { calls, fetchImpl };
}

function clientFor(fetchImpl, retrySleeps = []) {
	return new AppStoreConnectClient({
		keyId: "KEY123",
		issuerId: "issuer-1",
		privateKey: privateKeyPem,
		baseUrl: "https://example.test/v1",
		fetchImpl,
		maxGetRetries: 2,
		sleep: async (milliseconds) => retrySleeps.push(milliseconds),
	});
}

function runVerification(client, options = {}) {
	return verifyTestFlightBuild({
		client,
		bundleId: "com.hans.pigeon.reader",
		marketingVersion: "1.0",
		buildNumber: "456",
		timeoutMs: 100,
		pollIntervalMs: 10,
		now: options.now,
		sleep: options.sleep,
	});
}

test("app build polling uses the supported endpoint query shape", async () => {
	const { calls, fetchImpl } = queuedFetch([response({ data: [build()] })]);
	await clientFor(fetchImpl).listBuilds("app-1");

	assert.equal(calls[0].url.pathname, "/v1/apps/app-1/builds");
	assert.deepEqual([...calls[0].url.searchParams.keys()], ["limit"]);
	assert.equal(calls[0].url.searchParams.get("limit"), "200");
});

test("delayed build appearance and processing eventually attach the exact build", async () => {
	const { calls, fetchImpl } = queuedFetch([
		response(appPage()),
		response({ data: [] }),
		response({ data: [build("build-1", "456", "PROCESSING")] }),
		response({ data: [build()] }),
		response({ data: [group()] }),
		response({ data: [] }),
		response(undefined, 204),
		response({ data: [build()] }),
		response({ data: [{ type: "betaTesters", id: "tester-1" }] }),
	]);
	let clock = 0;
	const result = await runVerification(clientFor(fetchImpl), {
		now: () => clock,
		sleep: async (milliseconds) => {
			clock += milliseconds;
		},
	});

	assert.equal(result.processingState, "VALID");
	assert.match(result.attachmentEvidence, /attached by this verification job/);
	const attachCall = calls.find((call) => call.init.method === "POST");
	assert.equal(attachCall.url.pathname, "/v1/betaGroups/group-1/relationships/builds");
	assert.deepEqual(JSON.parse(attachCall.init.body), { data: [{ type: "builds", id: "build-1" }] });
});

test("already-attached build is verified without another relationship mutation", async () => {
	const { calls, fetchImpl } = queuedFetch([
		response(appPage()),
		response({ data: [build()] }),
		response({ data: [group()] }),
		response({ data: [build()] }),
		response({ data: [{ type: "betaTesters", id: "tester-1" }] }),
	]);
	const result = await runVerification(clientFor(fetchImpl), { now: () => 0, sleep: async () => {} });

	assert.match(result.attachmentEvidence, /already attached/);
	assert.equal(calls.some((call) => call.init.method === "POST"), false);
});

test("all-builds group is treated as exact-build access without a POST", async () => {
	const { calls, fetchImpl } = queuedFetch([
		response(appPage()),
		response({ data: [build()] }),
		response({ data: [group({ allBuilds: true })] }),
		response({ data: [build()] }),
		response({ data: [{ type: "betaTesters", id: "tester-1" }] }),
	]);
	const result = await runVerification(clientFor(fetchImpl), { now: () => 0, sleep: async () => {} });

	assert.match(result.attachmentEvidence, /all builds/);
	assert.match(result.attachmentEvidence, /build-1/);
	assert.equal(calls.some((call) => call.init.method === "POST"), false);
});

test("all-builds group waits for delayed exact-build relationship propagation", async () => {
	const { calls, fetchImpl } = queuedFetch([
		response(appPage()),
		response({ data: [build()] }),
		response({ data: [group({ allBuilds: true })] }),
		response({ data: [] }),
		response({ data: [] }),
		response({ data: [build()] }),
		response({ data: [{ type: "betaTesters", id: "tester-1" }] }),
	]);
	let clock = 0;
	const result = await runVerification(clientFor(fetchImpl), {
		now: () => clock,
		sleep: async (milliseconds) => {
			clock += milliseconds;
		},
	});

	assert.match(result.attachmentEvidence, /all builds.*exact build build-1 is listed/);
	assert.equal(calls.some((call) => call.init.method === "POST"), false);
});

test("successful relationship POST waits for delayed exact-build propagation", async () => {
	const { calls, fetchImpl } = queuedFetch([
		response(appPage()),
		response({ data: [build()] }),
		response({ data: [group()] }),
		response({ data: [] }),
		response(undefined, 204),
		response({ data: [] }),
		response({ data: [] }),
		response({ data: [build()] }),
		response({ data: [{ type: "betaTesters", id: "tester-1" }] }),
	]);
	let clock = 0;
	const result = await runVerification(clientFor(fetchImpl), {
		now: () => clock,
		sleep: async (milliseconds) => {
			clock += milliseconds;
		},
	});

	assert.match(result.attachmentEvidence, /attached by this verification job/);
	assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
});

test("409 during group attachment is reconciled by re-reading the exact build relationship", async () => {
	const { calls, fetchImpl } = queuedFetch([
		response(appPage()),
		response({ data: [build()] }),
		response({ data: [group()] }),
		response({ data: [] }),
		response({ errors: [{ code: "CONFLICT", detail: "Build is already being added" }] }, 409),
		response({ data: [build()] }),
		response({ data: [{ type: "betaTesters", id: "tester-1" }] }),
	]);
	const result = await runVerification(clientFor(fetchImpl), { now: () => 0, sleep: async () => {} });

	assert.match(result.attachmentEvidence, /already present after an idempotent attach conflict/);
	assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
});

test("terminal FAILED processing state stops before group access", async () => {
	const { calls, fetchImpl } = queuedFetch([
		response(appPage()),
		response({ data: [build("build-1", "456", "FAILED")] }),
	]);

	await assert.rejects(
		() => runVerification(clientFor(fetchImpl), { now: () => 0, sleep: async () => {} }),
		/terminal processingState FAILED/,
	);
	assert.equal(calls.length, 2);
});

test("missing build reports a useful processing timeout", async () => {
	const { fetchImpl } = queuedFetch([
		response(appPage()),
		...Array.from({ length: 11 }, () => response({ data: [] })),
	]);
	let clock = 0;

	await assert.rejects(
		() =>
			runVerification(clientFor(fetchImpl), {
				now: () => clock,
				sleep: async (milliseconds) => {
					clock += milliseconds;
				},
			}),
		/to appear and reach processingState VALID \(last observed: not found\)/,
	);
});

test("missing group relationship reports a bounded exact-availability timeout", async () => {
	const { fetchImpl } = queuedFetch([
		response(appPage()),
		response({ data: [build()] }),
		response({ data: [group()] }),
		response({ data: [] }),
		response(undefined, 204),
		...Array.from({ length: 5 }, () => response({ data: [] })),
	]);
	let clock = 0;

	await assert.rejects(
		() =>
			runVerification(clientFor(fetchImpl), {
				now: () => clock,
				sleep: async (milliseconds) => {
					clock += milliseconds;
				},
			}),
		/Timed out after 100 ms waiting for exact App Store Connect build build-1 to appear in beta group group-1's builds relationship/,
	);
});

test("pagination is followed for apps, builds, groups, group builds, and testers", async () => {
	const next = (resource) => `https://example.test/v1/${resource}?page=2`;
	const { calls, fetchImpl } = queuedFetch([
		response({ data: [], links: { next: next("apps") } }),
		response(appPage()),
		response({ data: [build("other", "1")], links: { next: next("apps/app-1/builds") } }),
		response({ data: [build()] }),
		response({ data: [{ ...group(), id: "other-group", attributes: { name: "Other", hasAccessToAllBuilds: false } }], links: { next: next("apps/app-1/betaGroups") } }),
		response({ data: [group()] }),
		response({ data: [{ type: "builds", id: "other" }], links: { next: next("betaGroups/group-1/builds") } }),
		response({ data: [build()] }),
		response({ data: [], links: { next: next("betaGroups/group-1/betaTesters") } }),
		response({ data: [{ type: "betaTesters", id: "tester-1" }] }),
	]);

	const result = await runVerification(clientFor(fetchImpl), { now: () => 0, sleep: async () => {} });
	assert.equal(result.testerCount, 1);
	assert.equal(calls.length, 10);
});

test("429 and 5xx polling responses are retried without changing the upload path", async () => {
	const retrySleeps = [];
	const { fetchImpl } = queuedFetch([
		response(appPage()),
		response(undefined, 429, { "retry-after": "0" }),
		response(undefined, 503),
		response({ data: [build()] }),
		response({ data: [group()] }),
		response({ data: [build()] }),
		response({ data: [{ type: "betaTesters", id: "tester-1" }] }),
	]);
	const result = await runVerification(clientFor(fetchImpl, retrySleeps), { now: () => 0, sleep: async () => {} });

	assert.equal(result.processingState, "VALID");
	assert.equal(retrySleeps.length, 2);
});

test("authorization failure identifies the API configuration without leaking the private key", async () => {
	const { fetchImpl } = queuedFetch([
		response({ errors: [{ code: "NOT_AUTHORIZED", detail: "Invalid JWT" }] }, 401),
	]);
	const client = clientFor(fetchImpl);

	await assert.rejects(client.findAppByBundleId("com.hans.pigeon.reader"), (error) => {
		assert.equal(error instanceof AppStoreConnectApiError, true);
		assert.match(error.message, /HTTP 401/);
		assert.match(error.message, /APP_STORE_CONNECT_KEY_ID/);
		assert.match(error.message, /API key role/);
		assert.equal(error.message.includes(privateKeyPem), false);
		return true;
	});
});

test("JWT uses App Store Connect audience and expires within twenty minutes", async () => {
	const { fetchImpl, calls } = queuedFetch([response(appPage())]);
	await clientFor(fetchImpl).findAppByBundleId("com.hans.pigeon.reader");

	const authorization = calls[0].init.headers.Authorization;
	const payload = JSON.parse(Buffer.from(authorization.split(".")[1], "base64url").toString("utf8"));
	assert.equal(payload.aud, "appstoreconnect-v1");
	assert.ok(payload.exp - payload.iat <= 1_200);
});

test("summary contains app, bundle, version, build, processing, group, and tester evidence", () => {
	const summary = formatVerificationSummary({
		app: { id: "app-1", attributes: { name: "Pigeon" } },
		bundleId: "com.hans.pigeon.reader",
		marketingVersion: "1.0",
		buildNumber: "456",
		processingState: "VALID",
		group: { id: "group-1" },
		groupName: "Pigeon Internal",
		attachmentEvidence: "exact build build-1 already attached",
		testerCount: 1,
	});

	assert.match(summary, /App: Pigeon \(app-1\)/);
	assert.match(summary, /Bundle ID: com\.hans\.pigeon\.reader/);
	assert.match(summary, /Version: 1\.0/);
	assert.match(summary, /Build: 456 \(VALID\)/);
	assert.match(summary, /Group: Pigeon Internal \(group-1\)/);
	assert.match(summary, /Testers in group: 1/);
});
