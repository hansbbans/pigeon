import { sign } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const DEFAULT_API_BASE_URL = "https://api.appstoreconnect.apple.com/v1";
const DEFAULT_GROUP_NAME = "Pigeon Internal";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;
const DEFAULT_MAX_GET_RETRIES = 4;
const JWT_LIFETIME_SECONDS = 15 * 60;

function base64Url(value) {
	return Buffer.from(value).toString("base64url");
}

function normalizePrivateKey(value) {
	return value.replace(/\\r?\\n/g, "\n").replace(/\r\n/g, "\n");
}

function requiredString(value, name) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Missing required ${name}.`);
	}
	return value.trim();
}

function createToken({ keyId, issuerId, privateKey, now = Date.now }) {
	const normalizedKeyId = requiredString(keyId, "APP_STORE_CONNECT_KEY_ID");
	const normalizedIssuerId = requiredString(issuerId, "APP_STORE_CONNECT_ISSUER_ID");
	const normalizedPrivateKey = requiredString(privateKey, "APP_STORE_CONNECT_PRIVATE_KEY");
	const issuedAt = Math.floor(now() / 1000);
	const header = base64Url(JSON.stringify({ alg: "ES256", kid: normalizedKeyId, typ: "JWT" }));
	const payload = base64Url(
		JSON.stringify({
			iss: normalizedIssuerId,
			iat: issuedAt,
			exp: issuedAt + JWT_LIFETIME_SECONDS,
			aud: "appstoreconnect-v1",
		}),
	);

	try {
		const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
			key: normalizePrivateKey(normalizedPrivateKey),
			dsaEncoding: "ieee-p1363",
		});
		return `${header}.${payload}.${base64Url(signature)}`;
	} catch {
		throw new Error("Unable to sign an App Store Connect API token with APP_STORE_CONNECT_PRIVATE_KEY.");
	}
}

function errorDetail(payload) {
	if (!payload || !Array.isArray(payload.errors)) return "";
	return payload.errors
		.map((error) => [error.code, error.title, error.detail].filter(Boolean).join(": "))
		.filter(Boolean)
		.join("; ")
		.replace(/\s+/g, " ")
		.slice(0, 400);
}

function responseRetryDelay(response, attempt) {
	const retryAfter = response.headers?.get?.("retry-after") ?? response.headers?.["retry-after"];
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
		const date = Date.parse(retryAfter);
		if (Number.isFinite(date)) return Math.max(0, date - Date.now());
	}
	return Math.min(30_000, 1_000 * 2 ** attempt);
}

function isRetryableStatus(status) {
	return status === 429 || status >= 500;
}

export class AppStoreConnectApiError extends Error {
	constructor(message, { status, method, url, detail } = {}) {
		super(message);
		this.name = "AppStoreConnectApiError";
		this.status = status;
		this.method = method;
		this.url = url;
		this.detail = detail;
	}
}

export class AppStoreConnectClient {
	constructor({
		keyId,
		issuerId,
		privateKey,
		baseUrl = DEFAULT_API_BASE_URL,
		fetchImpl = globalThis.fetch,
		now = Date.now,
		sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
		maxGetRetries = DEFAULT_MAX_GET_RETRIES,
	} = {}) {
		this.keyId = requiredString(keyId, "APP_STORE_CONNECT_KEY_ID");
		this.issuerId = requiredString(issuerId, "APP_STORE_CONNECT_ISSUER_ID");
		this.privateKey = requiredString(privateKey, "APP_STORE_CONNECT_PRIVATE_KEY");
		this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
		this.fetchImpl = fetchImpl;
		this.now = now;
		this.sleep = sleep;
		this.maxGetRetries = maxGetRetries;
		if (typeof this.fetchImpl !== "function") throw new Error("This Node runtime does not provide fetch.");
	}

	urlFor(resource) {
		if (resource instanceof URL) return resource;
		if (/^https?:\/\//i.test(resource)) return new URL(resource);
		return new URL(resource.replace(/^\/+/, ""), this.baseUrl);
	}

	async request(resource, { method = "GET", body, retry = method === "GET" } = {}) {
		const url = this.urlFor(resource);
		const maxRetries = retry && method === "GET" ? this.maxGetRetries : 0;

		for (let attempt = 0; ; attempt += 1) {
			const headers = {
				Accept: "application/json",
				Authorization: `Bearer ${createToken({
					keyId: this.keyId,
					issuerId: this.issuerId,
					privateKey: this.privateKey,
					now: this.now,
				})}`,
			};
			if (body !== undefined) headers["Content-Type"] = "application/json";

			let response;
			try {
				response = await this.fetchImpl(url, {
					method,
					headers,
					body: body === undefined ? undefined : JSON.stringify(body),
				});
			} catch (error) {
				if (attempt < maxRetries) {
					await this.sleep(Math.min(30_000, 1_000 * 2 ** attempt));
					continue;
				}
				const detail = error instanceof Error ? error.message : String(error);
				throw new AppStoreConnectApiError(
					`App Store Connect API network request failed for ${method} ${url.pathname}: ${detail}`,
					{ method, url: url.toString(), detail },
				);
			}

			let payload;
			const text = await response.text();
			if (text.trim() !== "") {
				try {
					payload = JSON.parse(text);
				} catch {
					payload = { raw: text };
				}
			}

			if (response.ok) return payload;

			const detail = errorDetail(payload);
			const statusText = response.statusText ? ` ${response.statusText}` : "";
			const authHint =
				response.status === 401 || response.status === 403
					? " Check APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID, and the App Store Connect API key role."
					: "";
			const apiError = new AppStoreConnectApiError(
				`App Store Connect API request failed for ${method} ${url.pathname}: HTTP ${response.status}${statusText}${detail ? ` (${detail})` : ""}.${authHint}`,
				{ status: response.status, method, url: url.toString(), detail },
			);

			if (attempt < maxRetries && isRetryableStatus(response.status)) {
				await this.sleep(responseRetryDelay(response, attempt));
				continue;
			}
			throw apiError;
		}
	}

	async list(resource) {
		const data = [];
		const seen = new Set();
		let next = this.urlFor(resource);
		while (next) {
			const key = next.toString();
			if (seen.has(key)) throw new Error(`App Store Connect API pagination loop detected at ${next.pathname}.`);
			seen.add(key);
			const page = await this.request(next);
			if (!page || !Array.isArray(page.data)) {
				throw new Error(`App Store Connect API returned no data array for ${next.pathname}.`);
			}
			data.push(...page.data);
			next = page.links?.next ? new URL(page.links.next, next) : undefined;
		}
		return data;
	}

	async findAppByBundleId(bundleId) {
		const query = new URLSearchParams({ "filter[bundleId]": requiredString(bundleId, "bundle ID"), limit: "200" });
		const apps = await this.list(`/apps?${query}`);
		const matches = apps.filter((app) => app?.attributes?.bundleId === bundleId);
		if (matches.length === 0) throw new Error(`No App Store Connect app matched bundle ID ${bundleId}.`);
		if (matches.length > 1) throw new Error(`Multiple App Store Connect apps matched bundle ID ${bundleId}.`);
		return matches[0];
	}

	listBuilds(appId) {
		return this.list(`/apps/${encodeURIComponent(appId)}/builds?limit=200`);
	}

	listBetaGroups(appId) {
		return this.list(`/apps/${encodeURIComponent(appId)}/betaGroups?limit=200`);
	}

	listBetaGroupBuilds(groupId) {
		return this.list(`/betaGroups/${encodeURIComponent(groupId)}/builds?limit=200`);
	}

	listBetaGroupTesters(groupId) {
		return this.list(`/betaGroups/${encodeURIComponent(groupId)}/betaTesters?limit=200`);
	}

	addBuildToBetaGroup(groupId, buildId) {
		return this.request(`/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`, {
			method: "POST",
			retry: false,
			body: { data: [{ type: "builds", id: buildId }] },
		});
	}
}

function buildNumberMatches(build, buildNumber) {
	return String(build?.attributes?.version ?? "") === String(buildNumber);
}

export async function waitForValidBuild({
	client,
	appId,
	buildNumber,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	now = Date.now,
	sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
} = {}) {
	const normalizedBuildNumber = requiredString(String(buildNumber ?? ""), "build number");
	const deadline = now() + timeoutMs;
	let lastObservedState = "not found";

	for (;;) {
		const matches = (await client.listBuilds(appId)).filter((build) => buildNumberMatches(build, normalizedBuildNumber));
		if (matches.length > 1) {
			throw new Error(`Multiple App Store Connect builds matched build number ${normalizedBuildNumber}.`);
		}
		const build = matches[0];
		if (build) {
			lastObservedState = build.attributes?.processingState ?? "unknown";
			if (lastObservedState === "VALID") return { build, attempts: undefined };
			if (lastObservedState === "FAILED" || lastObservedState === "INVALID") {
				throw new Error(
					`App Store Connect build ${normalizedBuildNumber} reached terminal processingState ${lastObservedState}; expected VALID.`,
				);
			}
		}

		const remainingMs = deadline - now();
		if (remainingMs <= 0) {
			throw new Error(
				`Timed out after ${timeoutMs} ms waiting for App Store Connect build ${normalizedBuildNumber} to appear and reach processingState VALID (last observed: ${lastObservedState}).`,
			);
		}
		await sleep(Math.min(pollIntervalMs, remainingMs));
	}
}

function exactResourceId(resources, expectedId) {
	return resources.some((resource) => String(resource?.id) === String(expectedId));
}

export async function waitForExactGroupBuild({
	client,
	groupId,
	buildId,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	now = Date.now,
	sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
	initialBuilds,
} = {}) {
	const deadline = now() + timeoutMs;
	let groupBuilds = initialBuilds ?? (await client.listBetaGroupBuilds(groupId));
	let delayMs = Math.max(1, pollIntervalMs);

	for (;;) {
		const exactBuild = groupBuilds.find((resource) => String(resource?.id) === String(buildId));
		if (exactBuild) return { build: exactBuild };

		const remainingMs = deadline - now();
		if (remainingMs <= 0) {
			throw new Error(
				`Timed out after ${timeoutMs} ms waiting for exact App Store Connect build ${buildId} to appear in beta group ${groupId}'s builds relationship.`,
			);
		}

		await sleep(Math.min(delayMs, remainingMs));
		delayMs = Math.min(30_000, delayMs * 2);
		groupBuilds = await client.listBetaGroupBuilds(groupId);
	}
}

export async function verifyTestFlightBuild({
	client,
	bundleId,
	marketingVersion,
	buildNumber,
	groupName = DEFAULT_GROUP_NAME,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	now = Date.now,
	sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
} = {}) {
	const normalizedBundleId = requiredString(bundleId, "bundle ID");
	const normalizedGroupName = requiredString(groupName, "beta group name");
	const app = await client.findAppByBundleId(normalizedBundleId);
	const buildResult = await waitForValidBuild({
		client,
		appId: app.id,
		buildNumber,
		timeoutMs,
		pollIntervalMs,
		now,
		sleep,
	});
	const build = buildResult.build;

	const groups = await client.listBetaGroups(app.id);
	const matchingGroups = groups.filter((group) => group?.attributes?.name === normalizedGroupName);
	if (matchingGroups.length === 0) {
		throw new Error(`No App Store Connect beta group named exactly ${normalizedGroupName} exists for ${normalizedBundleId}.`);
	}
	if (matchingGroups.length > 1) {
		throw new Error(`Multiple App Store Connect beta groups named exactly ${normalizedGroupName} exist for ${normalizedBundleId}.`);
	}
	const group = matchingGroups[0];
	const allBuilds = group.attributes?.hasAccessToAllBuilds === true;
	let groupBuilds = await client.listBetaGroupBuilds(group.id);
	let exactBuildAttached = exactResourceId(groupBuilds, build.id);
	let attachmentEvidence;

	if (allBuilds) {
		await waitForExactGroupBuild({
			client,
			groupId: group.id,
			buildId: build.id,
			timeoutMs,
			pollIntervalMs,
			now,
			sleep,
			initialBuilds: groupBuilds,
		});
		attachmentEvidence = `all builds (hasAccessToAllBuilds=true; exact build ${build.id} is listed)`;
	} else {
		if (!exactBuildAttached) {
			try {
				await client.addBuildToBetaGroup(group.id, build.id);
			} catch (error) {
				if (!(error instanceof AppStoreConnectApiError) || ![409, 422, 429, 500, 502, 503, 504].includes(error.status)) {
					throw error;
				}
				await waitForExactGroupBuild({
					client,
					groupId: group.id,
					buildId: build.id,
					timeoutMs,
					pollIntervalMs,
					now,
					sleep,
				});
				attachmentEvidence = `exact build ${build.id} already present after an idempotent attach conflict`;
			}
			if (!attachmentEvidence) {
				await waitForExactGroupBuild({
					client,
					groupId: group.id,
					buildId: build.id,
					timeoutMs,
					pollIntervalMs,
					now,
					sleep,
				});
				attachmentEvidence = `exact build ${build.id} attached by this verification job`;
			}
		} else {
			attachmentEvidence = `exact build ${build.id} already attached`;
		}
	}

	const testers = await client.listBetaGroupTesters(group.id);
	if (testers.length < 1) {
		throw new Error(`App Store Connect beta group ${normalizedGroupName} has no testers; refusing to report TestFlight availability.`);
	}

	return {
		app,
		bundleId: normalizedBundleId,
		marketingVersion: marketingVersion ?? "not supplied by upload metadata",
		build,
		buildNumber: String(buildNumber),
		processingState: build.attributes?.processingState,
		group,
		groupName: normalizedGroupName,
		attachmentEvidence,
		testerCount: testers.length,
	};
}

export function formatVerificationSummary(result) {
	const appName = result.app.attributes?.name ?? result.app.id;
	return [
		"### Pigeon App Store Connect verification",
		`- App: ${appName} (${result.app.id})`,
		`- Bundle ID: ${result.bundleId}`,
		`- Version: ${result.marketingVersion}`,
		`- Build: ${result.buildNumber} (${result.processingState})`,
		`- Group: ${result.groupName} (${result.group.id})`,
		`- Group build evidence: ${result.attachmentEvidence}`,
		`- Testers in group: ${result.testerCount}`,
	].join("\n");
}

function environmentInteger(environment, name, fallback) {
	const value = environment[name];
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number.`);
	return parsed * 1000;
}

export async function verifyFromEnvironment(environment = process.env, dependencies = {}) {
	const client = new AppStoreConnectClient({
		keyId: environment.APP_STORE_CONNECT_KEY_ID,
		issuerId: environment.APP_STORE_CONNECT_ISSUER_ID,
		privateKey: environment.APP_STORE_CONNECT_PRIVATE_KEY,
		fetchImpl: dependencies.fetchImpl,
	});
	const result = await verifyTestFlightBuild({
		client,
		bundleId: environment.BUNDLE_ID,
		marketingVersion: environment.MARKETING_VERSION,
		buildNumber: environment.BUILD_NUMBER,
		groupName: environment.BETA_GROUP_NAME || DEFAULT_GROUP_NAME,
		timeoutMs: environmentInteger(environment, "ASC_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_MS / 1000),
		pollIntervalMs: environmentInteger(environment, "ASC_POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_MS / 1000),
	});
	return result;
}

async function main() {
	try {
		const result = await verifyFromEnvironment();
		console.log(formatVerificationSummary(result));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`App Store Connect verification failed: ${message}`);
		process.exitCode = 1;
	}
}

const invokedScript = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedScript) await main();
