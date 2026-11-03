/** Pigeon server address handling. Plain functions so they run under node --test. */

export const DEFAULT_PIGEON_URL = 'https://pigeon.hanscho.com';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class PigeonUrlError extends Error {}

/**
 * Turns what the user typed into the Pigeon origin (scheme, host, port).
 * The Worker serves its API from the root, so any path is dropped.
 * Plain http is only accepted for a local `wrangler dev`: the password and
 * token would otherwise cross the network in the clear.
 */
export function normalizePigeonUrl(input: string): string {
	let raw = input.trim();
	if (!raw) throw new PigeonUrlError('Enter your Pigeon address.');
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new PigeonUrlError('That is not a valid address.');
	}
	if (url.username || url.password) throw new PigeonUrlError('The address must not contain a user name or password.');
	if (url.protocol === 'http:') {
		if (!LOOPBACK_HOSTS.has(url.hostname)) throw new PigeonUrlError('Use https (http only works for localhost).');
	} else if (url.protocol !== 'https:') {
		throw new PigeonUrlError('The address must start with https://.');
	}
	return url.origin;
}

/**
 * Host permission match pattern for one Pigeon origin. Match patterns leave
 * the port out (a pattern without one covers every port), so a local
 * `wrangler dev` on :8787 is covered by `http://localhost/*`.
 */
export function originPermissionPattern(origin: string): string {
	const url = new URL(origin);
	return `${url.protocol}//${url.hostname}/*`;
}

/** The Worker rejects longer URLs (`MAX_SAVED_URL_LENGTH` in src/saved-items.ts). */
export const MAX_SAVED_URL_LENGTH = 2048;

/** Only web pages can be saved; browser pages (chrome://, file://, the Web Store) cannot. */
export function isSaveableUrl(value: string | undefined | null): value is string {
	if (!value || value.length > MAX_SAVED_URL_LENGTH) return false;
	try {
		const url = new URL(value);
		return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) && !url.username && !url.password;
	} catch {
		return false;
	}
}
