/**
 * Host access to the Pigeon origin, and the few places Safari differs.
 *
 * Chromium grants the manifest's host permission at install. Safari does not:
 * the user allows each site (and may allow it for one day only), and Chrome
 * users can withhold site access too. Without that access a request to Pigeon
 * fails like a network error, so a save would wait in the queue forever
 * looking like "Pigeon is unreachable". Checking first lets the extension ask
 * for access instead.
 */

import { originPermissionPattern } from './config';

/** `permissions.contains` for one origin pattern. */
export type HostAccessCheck = (pattern: string) => Promise<boolean>;

/**
 * True when the extension may reach `origin`. No check (a test, a browser
 * without the API) or a check that throws counts as access: the request then
 * runs and fails or succeeds on its own, as before.
 */
export async function hasHostAccess(origin: string, check: HostAccessCheck | undefined): Promise<boolean> {
	if (!check) return true;
	try {
		return await check(originPermissionPattern(origin));
	} catch {
		return true;
	}
}

export type BrowserFamily = 'safari' | 'chromium';

/** Which browser runs the extension, from the scheme of its own pages (`runtime.getURL('')`). */
export function browserFamily(extensionBaseUrl: string): BrowserFamily {
	return extensionBaseUrl.startsWith('safari-web-extension:') ? 'safari' : 'chromium';
}

/**
 * What the options page shows for the save shortcut. Chromium lets the user
 * set or change it; Safari has no settings for extension shortcuts, so when
 * Safari did not assign it (another extension or the app menu has it) there is none.
 */
export function shortcutLabel(shortcut: string | undefined, family: BrowserFamily): string {
	if (shortcut) return shortcut;
	if (family === 'safari') return 'a shortcut (Safari did not assign one; use the toolbar button)';
	return 'a shortcut (set one at chrome://extensions/shortcuts)';
}
