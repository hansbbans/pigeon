/**
 * Service worker: wires browser events to the save flow in src/core.
 * Requests to Pigeon go from here, under the Pigeon host permission, so the
 * Worker needs no CORS headers.
 */

import browser, { type Tabs } from '../browser-api';
import type { PageExtraction } from '../core/payload';
import { readQueue } from '../core/queue';
import { nextRetryState, parseRetryState, retryDue } from '../core/retry';
import { flushQueue, isSending, saveLink, savePage, type SaveDeps, type SaveOutcome } from '../core/save';

const MENU_SAVE_PAGE = 'pigeon-save-page';
const MENU_SAVE_LINK = 'pigeon-save-link';
const COMMAND_SAVE_PAGE = 'save-page';
const EXTRACTION_TIMEOUT_MS = 20_000;
const BADGE_CLEAR_MS = 5_000;
const DEFAULT_TITLE = 'Save to Pigeon';
const DEFAULT_COLOR = '#6b7280';
/** Backoff for opportunistic retries; storage.session survives worker restarts, not browser restarts. */
const RETRY_STATE_KEY = 'pigeonRetry';
/** An extension API call every 20 s keeps the worker alive while a save is in flight. */
const KEEPALIVE_MS = 20_000;

const deps: SaveDeps = {
	fetch: (input, init) => fetch(input, init),
	store: browser.storage.local,
};

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

browser.action.onClicked.addListener((tab) => {
	void saveTab(tab);
});

browser.commands.onCommand.addListener((command, tab) => {
	if (command !== COMMAND_SAVE_PAGE) return;
	void (async () => {
		const target = tab ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0];
		if (target) await saveTab(target);
	})();
});

browser.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId === MENU_SAVE_LINK) {
		void (async () => {
			const tabId = tab?.id;
			await showBusy(tabId);
			report(tabId, await keepAlive(saveLink(info.linkUrl, deps)));
		})();
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

// Browsing is a sign the network may be back: retry queued saves, subject to the backoff.
browser.tabs.onUpdated.addListener((_tabId, change) => {
	if (change.status === 'complete') void retryQueued({ force: false });
});

async function saveTab(tab: Tabs.Tab): Promise<void> {
	const tabId = tab.id;
	await showBusy(tabId);
	const outcome = await keepAlive(savePage({ url: tab.url, title: tab.title }, tabId === undefined ? null : () => extractFromTab(tabId), deps));
	report(tabId, outcome);
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

/** Sends queued saves. `force` skips the backoff (the user just saved or signed in). */
async function retryQueued({ force }: { force: boolean }): Promise<void> {
	if (retryRunning && !force) return;
	retryRunning = true;
	try {
		const now = Date.now();
		const state = parseRetryState((await browser.storage.session.get(RETRY_STATE_KEY))[RETRY_STATE_KEY]);
		if (!force && !retryDue(state, now)) return;
		if ((await readQueue(deps.store)).length === 0) {
			if (force) await setGlobalBadge(0);
			return;
		}
		const result = await keepAlive(flushQueue(deps));
		const next = nextRetryState(force ? null : state, result, Date.now());
		if (next) await browser.storage.session.set({ [RETRY_STATE_KEY]: next });
		else await browser.storage.session.remove(RETRY_STATE_KEY);
		if (result.stoppedBy === 'unauthorized' || result.stoppedBy === 'signedOut') await setGlobalBadge(result.remaining, 'Sign in to Pigeon');
		else await setGlobalBadge(result.remaining);
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

async function showBusy(tabId: number | undefined): Promise<void> {
	await setTabBadge(tabId, '…', DEFAULT_COLOR, 'Saving to Pigeon…');
}

function report(tabId: number | undefined, outcome: SaveOutcome): void {
	void (async () => {
		switch (outcome.status) {
			case 'saved': {
				const title = outcome.withContent ? 'Saved to Pigeon' : 'Saved to Pigeon (link only; Pigeon will fetch the article)';
				await setTabBadge(tabId, '✓', '#15803d', title);
				setTimeout(() => void clearTabBadge(tabId), BADGE_CLEAR_MS);
				void retryQueued({ force: true });
				break;
			}
			case 'needsSignIn':
				await setTabBadge(tabId, '!', '#b91c1c', `Sign in to Pigeon. ${waiting(outcome.queued)}`);
				await setGlobalBadge(outcome.queued, 'Sign in to Pigeon');
				await browser.runtime.openOptionsPage();
				break;
			case 'queued':
				await setTabBadge(tabId, '!', '#b45309', `${outcome.message} ${waiting(outcome.queued)} Pigeon will retry.`);
				await setGlobalBadge(outcome.queued);
				break;
			case 'unsupported':
				await setTabBadge(tabId, '×', DEFAULT_COLOR, 'Only web pages can be saved to Pigeon.');
				setTimeout(() => void clearTabBadge(tabId), BADGE_CLEAR_MS);
				break;
			case 'failed':
				await setTabBadge(tabId, '!', '#b91c1c', `Pigeon could not save this: ${outcome.message}`);
				break;
		}
	})().catch((error) => console.warn('[Pigeon] Badge update failed:', error));
}

function waiting(count: number): string {
	return count === 1 ? '1 save is waiting.' : `${count} saves are waiting.`;
}

async function setTabBadge(tabId: number | undefined, text: string, color: string, title: string): Promise<void> {
	if (tabId === undefined) return setGlobal(text, color, title);
	try {
		await browser.action.setBadgeBackgroundColor({ tabId, color });
		await browser.action.setBadgeText({ tabId, text });
		await browser.action.setTitle({ tabId, title });
	} catch {
		// The tab closed meanwhile.
	}
}

/** Puts the tab back on the global badge (the queue count), its colour and its tooltip. */
async function clearTabBadge(tabId: number | undefined): Promise<void> {
	if (tabId === undefined) return;
	try {
		// Badge text: null drops the per-tab value. Colour and title have no reset in Chrome, so copy the global ones.
		const [color, title] = await Promise.all([browser.action.getBadgeBackgroundColor({}), browser.action.getTitle({})]);
		await browser.action.setBadgeText({ tabId, text: null });
		await browser.action.setBadgeBackgroundColor({ tabId, color });
		await browser.action.setTitle({ tabId, title });
	} catch {
		// The tab closed meanwhile.
	}
}

async function setGlobal(text: string, color: string, title: string): Promise<void> {
	await browser.action.setBadgeBackgroundColor({ color });
	await browser.action.setBadgeText({ text });
	await browser.action.setTitle({ title });
}

/** The badge every tab shows by default: how many saves are waiting. */
async function setGlobalBadge(queued: number, reason?: string): Promise<void> {
	if (queued <= 0) return setGlobal('', DEFAULT_COLOR, DEFAULT_TITLE);
	await setGlobal(String(queued), '#b45309', `${reason ? `${reason}. ` : ''}${waiting(queued)}`);
}

// A service worker restart is a good moment to retry (subject to the backoff).
void retryQueued({ force: false });
