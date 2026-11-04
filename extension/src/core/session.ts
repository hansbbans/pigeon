/**
 * What the extension keeps in storage.local. The password is never stored:
 * sign-in exchanges it for the token and drops it.
 */

import { DEFAULT_PIGEON_URL } from './config';

/** The subset of `browser.storage.local` the extension uses (and tests fake). */
export interface KeyValueStore {
	get(keys: string | string[]): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
}

const KEYS = { origin: 'pigeonOrigin', auth: 'pigeonAuth', needsSignIn: 'pigeonNeedsSignIn' } as const;
export const SETTINGS_KEYS: readonly string[] = Object.values(KEYS);

export interface Settings {
	/** Pigeon origin, e.g. https://pigeon.hanscho.com. */
	origin: string;
	/** `pigeon/<token>` from ClientLogin, or null when signed out. */
	auth: string | null;
	/** Set when Pigeon answered 401: the stored token stopped working. */
	needsSignIn: boolean;
}

export async function loadSettings(store: KeyValueStore): Promise<Settings> {
	const values = await store.get([KEYS.origin, KEYS.auth, KEYS.needsSignIn]);
	const origin = typeof values[KEYS.origin] === 'string' && values[KEYS.origin] ? (values[KEYS.origin] as string) : DEFAULT_PIGEON_URL;
	const auth = typeof values[KEYS.auth] === 'string' && values[KEYS.auth] ? (values[KEYS.auth] as string) : null;
	return { origin, auth, needsSignIn: values[KEYS.needsSignIn] === true };
}

export async function storeSignIn(store: KeyValueStore, origin: string, auth: string): Promise<void> {
	await store.set({ [KEYS.origin]: origin, [KEYS.auth]: auth, [KEYS.needsSignIn]: false });
}

/** Signing out forgets the token; the address stays so signing back in is one field. */
export async function signOut(store: KeyValueStore): Promise<void> {
	await store.remove([KEYS.auth, KEYS.needsSignIn]);
}

/**
 * After a 401: drop the dead token and ask for the password again. Only the
 * token that got the 401 is dropped; a late reply must not wipe a new sign-in.
 */
export async function markNeedsSignIn(store: KeyValueStore, rejectedAuth: string): Promise<void> {
	const current = (await store.get(KEYS.auth))[KEYS.auth];
	if (current !== rejectedAuth) return;
	await store.remove(KEYS.auth);
	await store.set({ [KEYS.needsSignIn]: true });
}
