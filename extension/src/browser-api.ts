/**
 * The one place that touches the WebExtension namespace. webextension-polyfill
 * gives Chromium the promise-based `browser.*` API that Safari and Firefox
 * already have, so a Safari or Firefox build only needs its own manifest.
 */
import browser from 'webextension-polyfill';

export default browser;
export type { Tabs, ContextMenus } from 'webextension-polyfill';
