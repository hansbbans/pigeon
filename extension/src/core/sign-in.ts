/** Options-page logic without the DOM: sign in, sign out, and what to show. */

import { clientLogin, type Fetch } from './api';
import { normalizePigeonUrl, originPermissionPattern, PigeonUrlError } from './config';
import { readQueue } from './queue';
import { loadSettings, signOut, storeSignIn, type KeyValueStore } from './session';

export interface SignInDeps {
	fetch: Fetch;
	store: KeyValueStore;
	/** permissions.request for one origin pattern; must be the first call in the click handler (user gesture). */
	requestHostPermission(pattern: string): Promise<boolean>;
}

export type SignInResult = { ok: true; origin: string } | { ok: false; field: 'url' | 'password' | 'general'; message: string };

/**
 * Normalizes the address, asks for host permission when it is not the
 * built-in Pigeon origin, runs ClientLogin once and stores only the token.
 * The password never reaches storage.
 */
export async function signIn(rawUrl: string, password: string, deps: SignInDeps): Promise<SignInResult> {
	let origin: string;
	try {
		origin = normalizePigeonUrl(rawUrl);
	} catch (error) {
		return { ok: false, field: 'url', message: error instanceof PigeonUrlError ? error.message : 'That is not a valid address.' };
	}
	if (!password) return { ok: false, field: 'password', message: 'Enter your Pigeon password.' };
	let granted = false;
	try {
		granted = await deps.requestHostPermission(originPermissionPattern(origin));
	} catch {
		granted = false;
	}
	if (!granted) return { ok: false, field: 'url', message: `The extension needs permission to reach ${origin}.` };
	const login = await clientLogin(deps.fetch, origin, password);
	if (!login.ok) return { ok: false, field: login.reason === 'badPassword' ? 'password' : 'general', message: login.message };
	await storeSignIn(deps.store, origin, login.auth);
	return { ok: true, origin };
}

export { signOut };

export interface OptionsState {
	origin: string;
	signedIn: boolean;
	needsSignIn: boolean;
	queued: number;
}

export async function optionsState(store: KeyValueStore): Promise<OptionsState> {
	const settings = await loadSettings(store);
	const queue = await readQueue(store);
	return { origin: settings.origin, signedIn: Boolean(settings.auth), needsSignIn: settings.needsSignIn, queued: queue.length };
}
