/** Options-page logic without the DOM: sign in, sign out, and what to show. */

import { hasHostAccess, type HostAccessCheck } from './access';
import { clientLogin, type Fetch } from './api';
import { normalizePigeonUrl, originPermissionPattern, PigeonUrlError } from './config';
import { QUEUE_SUMMARY_KEY, readQueueSummary } from './queue';
import { loadSettings, SETTINGS_KEYS, signOut, storeSignIn, type KeyValueStore } from './session';

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

/** What the options page's sign-in form does, so the flow can be tested without a DOM. */
export interface SignInForm {
	setBusy(busy: boolean): void;
	showError(field: 'url' | 'password' | 'general', message: string): void;
	signedIn(): Promise<void>;
}

/**
 * Handles one submit: never leaves the button disabled, and shows every
 * failure, including unexpected ones (storage errors, a rejected permission call).
 */
export async function submitSignIn(rawUrl: string, password: string, deps: SignInDeps, form: SignInForm): Promise<boolean> {
	form.setBusy(true);
	try {
		// signIn calls permissions.request before its first await, while the click still counts as a user gesture.
		const result = await signIn(rawUrl, password, deps);
		if (!result.ok) {
			form.showError(result.field, result.message);
			return false;
		}
		await form.signedIn();
		return true;
	} catch (error) {
		form.showError('general', `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	} finally {
		form.setBusy(false);
	}
}

export interface OptionsState {
	origin: string;
	signedIn: boolean;
	needsSignIn: boolean;
	queued: number;
}

export async function optionsState(store: KeyValueStore): Promise<OptionsState> {
	const settings = await loadSettings(store);
	const queue = await readQueueSummary(store);
	return { origin: settings.origin, signedIn: Boolean(settings.auth), needsSignIn: settings.needsSignIn, queued: queue.count };
}

/** storage.local keys the options page shows; other changes (queue contents, retry timing) need no re-render. */
export const OPTIONS_STATE_KEYS: readonly string[] = [...SETTINGS_KEYS, QUEUE_SUMMARY_KEY];

/**
 * Signed in, but the browser does not let the extension reach Pigeon: Safari
 * asks per site (and "Allow for One Day" runs out), and Chrome users can
 * withhold site access. Returns the pattern to request, or null when all is well.
 */
export async function missingHostAccess(store: KeyValueStore, check: HostAccessCheck | undefined): Promise<{ origin: string; pattern: string } | null> {
	const settings = await loadSettings(store);
	if (!settings.auth || (await hasHostAccess(settings.origin, check))) return null;
	return { origin: settings.origin, pattern: originPermissionPattern(settings.origin) };
}

/** The "Allow access" button: permissions.request must be its first call (user gesture). A refusal or an error is false. */
export async function grantHostAccess(pattern: string, request: (pattern: string) => Promise<boolean>): Promise<boolean> {
	try {
		return await request(pattern);
	} catch {
		return false;
	}
}
