/**
 * Pigeon HTTP calls. `fetch` is injected so tests run against a mock.
 * Login: `POST /accounts/ClientLogin` with form field `Passwd` (src/greader.ts);
 * the reply's `Auth=` line is `pigeon/<token>`, sent back as
 * `Authorization: GoogleLogin auth=pigeon/<token>` (src/api-auth.ts).
 */

import type { SaveRequestBody } from './payload';

export type Fetch = typeof globalThis.fetch;

const LOGIN_TIMEOUT_MS = 20_000;
/** Under Chrome's 30 s limit for a service worker waiting on one fetch. */
const SAVE_TIMEOUT_MS = 25_000;

/** The `Auth=` value from a ClientLogin reply, or null. */
export function parseClientLoginResponse(body: string): string | null {
	for (const line of body.split(/\r?\n/)) {
		const match = /^Auth=(\S+)$/.exec(line.trim());
		if (match) return match[1];
	}
	return null;
}

export function authorizationHeader(auth: string): string {
	return `GoogleLogin auth=${auth}`;
}

export type LoginResult =
	| { ok: true; auth: string }
	| { ok: false; reason: 'badPassword' | 'network' | 'server'; status?: number; message: string };

export async function clientLogin(fetchImpl: Fetch, origin: string, password: string): Promise<LoginResult> {
	let response: Response;
	try {
		response = await fetchImpl(`${origin}/accounts/ClientLogin`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ Passwd: password }).toString(),
			credentials: 'omit',
			signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
		});
	} catch {
		return { ok: false, reason: 'network', message: `Could not reach ${origin}.` };
	}
	if (response.status === 401 || response.status === 403) {
		return { ok: false, reason: 'badPassword', status: response.status, message: 'Incorrect password.' };
	}
	if (!response.ok) {
		return { ok: false, reason: 'server', status: response.status, message: `Pigeon answered ${response.status}.` };
	}
	let auth: string | null = null;
	try {
		auth = parseClientLoginResponse(await response.text());
	} catch {
		return { ok: false, reason: 'network', message: `Could not reach ${origin}.` };
	}
	if (!auth) return { ok: false, reason: 'server', status: response.status, message: 'That address does not look like a Pigeon server.' };
	return { ok: true, auth };
}

/** `POST /api/v1/saved` response. */
export interface SaveResponseBody {
	id: string;
	readerId?: string;
	url: string;
	state: 'pending' | 'done' | 'failed';
	created?: boolean;
	contentTooLarge?: boolean;
}

export type SaveResult =
	| { kind: 'ok'; body: SaveResponseBody }
	/** Missing or wrong token: sign in again. */
	| { kind: 'unauthorized' }
	/** 400 or 413: this request will never succeed as sent. */
	| { kind: 'rejected'; status: number; message: string }
	/** Offline, timed out, 5xx, or a reply that is not Pigeon's: try again later. */
	| { kind: 'retry'; message: string };

export async function postSave(fetchImpl: Fetch, origin: string, auth: string, body: SaveRequestBody): Promise<SaveResult> {
	let response: Response;
	try {
		response = await fetchImpl(`${origin}/api/v1/saved`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: authorizationHeader(auth) },
			body: JSON.stringify(body),
			credentials: 'omit',
			signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
		});
	} catch {
		return { kind: 'retry', message: 'Pigeon is unreachable.' };
	}
	if (response.status === 401) return { kind: 'unauthorized' };
	if (response.status === 400 || response.status === 413) {
		let message = `Pigeon rejected the save (${response.status}).`;
		try {
			const error = (await response.json()) as { error?: unknown };
			if (typeof error.error === 'string') message = error.error;
		} catch {
			// Plain-text or empty error body.
		}
		return { kind: 'rejected', status: response.status, message };
	}
	// A Worker without the save API (before PR #161 is deployed) answers 404; keep the save for later.
	if (response.status === 404) return { kind: 'retry', message: 'This Pigeon server cannot save links yet.' };
	if (!response.ok) return { kind: 'retry', message: `Pigeon answered ${response.status}.` };
	try {
		const parsed = (await response.json()) as SaveResponseBody;
		if (!parsed || typeof parsed.id !== 'string' || typeof parsed.state !== 'string') {
			return { kind: 'retry', message: 'Pigeon sent an unexpected reply.' };
		}
		return { kind: 'ok', body: parsed };
	} catch {
		return { kind: 'retry', message: 'Pigeon sent an unexpected reply.' };
	}
}
