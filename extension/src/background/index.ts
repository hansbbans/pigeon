/**
 * Service worker: wires browser events to the save flow in src/core.
 * Requests to Pigeon go from here, under the Pigeon host permission, so the
 * Worker needs no CORS headers.
 */

import browser, { type Tabs } from '../browser-api';
import { Badge, DEFAULT_COLOR, WAITING_COLOR, waiting, type ActionApi } from '../core/badge';
import type { PageExtraction } from '../core/payload';
import { ensureRetryScheduled, RETRY_ALARM, runRetry, type AlarmsApi } from '../core/retry';
import { flushQueue, guardSave, isSending, saveLink, savePage, type SaveDeps, type SaveOutcome } from '../core/save';

const MENU_SAVE_PAGE = 'pigeon-save-page';
const MENU_SAVE_LINK = 'pigeon-save-link';
const COMMAND_SAVE_PAGE = 'save-page';
const EXTRACTION_TIMEOUT_MS = 20_000;
const BADGE_CLEAR_MS = 5_000;
/** Problems stay on the tab a little longer, then the tab shows the global badge (the queue count). */
const BADGE_PROBLEM_CLEAR_MS = 10_000;
/** An extension API call every 20 s keeps the worker alive while a save is in flight. */
const KEEPALIVE_MS = 20_000;

const deps: SaveDeps = {
	fetch: (input, init) => fetch(input, init),
	store: browser.storage.local,
};
const alarms: AlarmsApi = browser.alarms;
const badge = new Badge(browser.action as unknown as ActionApi, browser.storage.session);

browser.runtime.onInstalled.addListener(async (details) => {
	if (details.reason === 'install') void browser.runtime.openOptionsPage();
	await browser.contextMenus.removeAll();
	browser.contextMenus.create({ id: MENU_SAVE_PAGE, title: 'Save page to Pigeon', contexts: ['page'] });
	browser.contextMenus.create({ id: MENU_SAVE_LINK, title: 'Save link to Pigeon', contexts: ['link'] });
	void retryQueued({ force: false });
});

browser.runtime.onStartup.addListener(() => {
	void retryQueued({ force: false });
});

// Queued saves are retried by an alarm (it survives worker restarts) with a backoff.
browser.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === RETRY_ALARM) void retryQueued({ force: false });
});

browser.tabs.onRemoved.addListener((tabId) => {
	void badge.forgetTab(tabId);
});

browser.action.onClicked.addListener((tab) => {
	void saveTab(tab);
});

browser.commands.onCommand.addListener((command, tab) => {
	if (command !== COMMAND_SAVE_PAGE) return;
	void (async () => {
		const target = tab ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0];
		if (target) await saveTab(target);
	})().catch((error) => console.error('[Pigeon] Shortcut failed:', error));
});

browser.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId === MENU_SAVE_LINK) {
		void runSave(tab?.id, () => saveLink(info.linkUrl, deps));
	} else if (info.menuItemId === MENU_SAVE_PAGE && tab) {
		void saveTab(tab);
	}
});

browser.runtime.onMessage.addListener((message: unknown) => {
	// The options page asks for a retry right after signing in.
	if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'pigeon:flush') {
		return retryQueued({ force: true }).then(() => true);
	}
	return undefined;
});

function saveTab(tab: Tabs.Tab): Promise<void> {
	const tabId = tab.id;
	return runSave(tabId, () => savePage({ url: tab.url, title: tab.title }, tabId === undefined ? null : () => extractFromTab(tabId), deps));
}

/** Shows progress, runs the save, and always ends in a visible state, even if something throws. */
async function runSave(tabId: number | undefined, save: () => Promise<SaveOutcome>): Promise<void> {
	await badge.showOnTab(tabId, '…', DEFAULT_COLOR, 'Saving to Pigeon…').catch(() => undefined);
	report(tabId, await keepAlive(guardSave(save)));
}

/** Injects the bundled Defuddle script into the tab (activeTab grant) and runs it. */
async function extractFromTab(tabId: number): Promise<PageExtraction | null> {
	const run = async () => {
		await browser.scripting.executeScript({ target: { tabId }, files: ['extract.js'] });
		const [frame] = await browser.scripting.executeScript({
			target: { tabId },
			func: () => (globalThis as { __pigeonExtract?: () => unknown }).__pigeonExtract?.() ?? null,
		});
		const result = frame?.result as PageExtraction | null | undefined;
		if (result?.error) console.info('[Pigeon] Extraction found no content; saving the link:', result.error);
		return result ?? null;
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), EXTRACTION_TIMEOUT_MS);
	});
	try {
		return await Promise.race([run(), timeout]);
	} catch (error) {
		// Restricted pages (the Web Store, PDF viewer, other extensions) refuse injection.
		console.info('[Pigeon] Could not read the page; saving the link:', error instanceof Error ? error.message : String(error));
		return null;
	} finally {
		clearTimeout(timer);
	}
}

let retryRunning = false;

/** Sends queued saves and updates the alarm and the global badge. `force` restarts the backoff. */
async function retryQueued({ force }: { force: boolean }): Promise<void> {
	if (retryRunning && !force) return;
	retryRunning = true;
	try {
		const result = await keepAlive(runRetry(force, { store: deps.store, alarms, flush: () => flushQueue(deps) }));
		if (!result) await badge.setQueued(0);
		else if (result.stoppedBy === 'unauthorized' || result.stoppedBy === 'signedOut') await badge.setQueued(result.remaining, 'Sign in to Pigeon');
		else await badge.setQueued(result.remaining);
	} catch (error) {
		console.warn('[Pigeon] Retrying queued saves failed:', error instanceof Error ? error.message : String(error));
	} finally {
		retryRunning = false;
	}
}

/**
 * Chrome stops an idle service worker after 30 s, even mid-fetch; calling an
 * extension API resets that timer. Queued saves survive a stop anyway; this
 * keeps a slow save from being cut off halfway.
 */
async function keepAlive<T>(work: Promise<T>): Promise<T> {
	const timer = setInterval(() => {
		if (isSending()) void browser.runtime.getPlatformInfo();
	}, KEEPALIVE_MS);
	try {
		return await work;
	} finally {
		clearInterval(timer);
	}
}

function report(tabId: number | undefined, outcome: SaveOutcome): void {
	void (async () => {
		switch (outcome.status) {
			case 'saved': {
				const title = outcome.withContent ? 'Saved to Pigeon' : 'Saved to Pigeon (link only; Pigeon will fetch the article)';
				await badge.showOnTab(tabId, '✓', '#15803d', title, BADGE_CLEAR_MS);
				void retryQueued({ force: true });
				break;
			}
			case 'needsSignIn':
				await badge.setQueued(outcome.queued, 'Sign in to Pigeon');
				await badge.showOnTab(tabId, '!', '#b91c1c', `Sign in to Pigeon. ${waiting(outcome.queued)}`, BADGE_PROBLEM_CLEAR_MS);
				await browser.runtime.openOptionsPage();
				break;
			case 'queued':
				await badge.setQueued(outcome.queued);
				await ensureRetryScheduled({ store: deps.store, alarms });
				await badge.showOnTab(tabId, '!', WAITING_COLOR, `${outcome.message} ${waiting(outcome.queued)} Pigeon will retry.`, BADGE_PROBLEM_CLEAR_MS);
				break;
			case 'unsupported':
				await badge.showOnTab(tabId, '×', DEFAULT_COLOR, 'Only web pages can be saved to Pigeon.', BADGE_CLEAR_MS);
				break;
			case 'failed':
				await badge.showOnTab(tabId, '!', '#b91c1c', `Pigeon could not save this: ${outcome.message}`, BADGE_PROBLEM_CLEAR_MS);
				break;
		}
	})().catch((error) => console.warn('[Pigeon] Badge update failed:', error));
}
