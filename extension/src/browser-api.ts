/**
 * The one place that touches the WebExtension namespace. webextension-polyfill
 * gives Chromium the promise-based `browser.*` API that Safari and Firefox
 * already have, so a Safari or Firefox build only needs its own manifest.
 */
import browser from 'webextension-polyfill';

export default browser;

/** Host permission for one origin match pattern (Safari grants these per site). */
export const hostPermission = {
	contains: (pattern: string): Promise<boolean> => browser.permissions.contains({ origins: [pattern] }),
	/** Must be the first call in a click handler: it needs the user gesture. */
	request: (pattern: string): Promise<boolean> => browser.permissions.request({ origins: [pattern] }),
};
export type { Tabs, ContextMenus } from 'webextension-polyfill';
