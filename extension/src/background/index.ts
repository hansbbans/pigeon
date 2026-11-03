/**
 * Service worker: wires browser events to the save flow in src/core.
 * Requests to Pigeon go from here, under the Pigeon host permission, so the
 * Worker needs no CORS headers.
 */

import browser, { type Tabs } from '../browser-api';
import type { PageExtraction } from '../core/payload';
import { readQueue } from '../core/queue';
import { flushQueue, saveLink, savePage, type SaveDeps, type SaveOutcome } from '../core/save';

const MENU_SAVE_PAGE = 'pigeon-save-page';
const MENU_SAVE_LINK = 'pigeon-save-link';
const COMMAND_SAVE_PAGE = 'save-page';
const EXTRACTION_TIMEOUT_MS = 20_000;
const BADGE_CLEAR_MS = 5_000;
/** Queued saves are retried on browsing activity, at most this often. */
const RETRY_INTERVAL_MS = 60_000;

const deps: SaveDeps = {
	fetch: (input, init) => fetch(input, init),
	store: browser.storage.local,
};

browser.runtime.onInstalled.addListener(async (details) => {
	if (details.reason === 'install') void browser.runtime.openOptionsPage();
	await browser.contextMenus.removeAll();
	browser.contextMenus.create({ id: MENU_SAVE_PAGE, title: 'Save page to Pigeon', contexts: ['page'] });
	browser.contextMenus.create({ id: MENU_SAVE_LINK, title: 'Save link to Pigeon', contexts: ['link'] });
	void retryQueued();
});

browser.runtime.onStartup.addListener(() => {
	void retryQueued();
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
			report(tabId, await saveLink(info.linkUrl, deps));
		})();
	} else if (info.menuItemId === MENU_SAVE_PAGE && tab) {
		void saveTab(tab);
	}
});

browser.runtime.onMessage.addListener((message: unknown) => {
	// The options page asks for a retry right after signing in.
	if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'pigeon:flush') {
		return retryQueued().then(() => true);
	}
	return undefined;
});

let lastRetry = 0;
browser.tabs.onUpdated.addListener((_tabId, change) => {
	if (change.status !== 'complete' || Date.now() - lastRetry < RETRY_INTERVAL_MS) return;
	lastRetry = Date.now();
	void retryQueued();
});

async function saveTab(tab: Tabs.Tab): Promise<void> {
	const tabId = tab.id;
	await showBusy(tabId);
	const outcome = await savePage({ url: tab.url, title: tab.title }, tabId === undefined ? null : () => extractFromTab(tabId), deps);
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

async function retryQueued(): Promise<void> {
	try {
		const result = await flushQueue(deps);
		if (result.stoppedBy === 'unauthorized') await setGlobalBadge(result.remaining, 'Sign in to Pigeon again');
		else await setGlobalBadge(result.remaining);
	} catch (error) {
		console.warn('[Pigeon] Retrying queued saves failed:', error instanceof Error ? error.message : String(error));
	}
}

async function showBusy(tabId: number | undefined): Promise<void> {
	await setTabBadge(tabId, '…', '#6b7280', 'Saving to Pigeon…');
}

function report(tabId: number | undefined, outcome: SaveOutcome): void {
	void (async () => {
		switch (outcome.status) {
			case 'saved': {
				const title = outcome.withContent ? 'Saved to Pigeon' : 'Saved to Pigeon (link only; Pigeon will fetch the article)';
				await setTabBadge(tabId, '✓', '#15803d', title);
				setTimeout(() => void clearTabBadge(tabId), BADGE_CLEAR_MS);
				void retryQueued();
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
				await setTabBadge(tabId, '×', '#6b7280', 'Only web pages can be saved to Pigeon.');
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

async function clearTabBadge(tabId: number | undefined): Promise<void> {
	if (tabId === undefined) return;
	try {
		// null (not '') drops the per-tab value, so the tab shows the global badge (the queue count) again.
		await browser.action.setBadgeText({ tabId, text: null });
		await browser.action.setTitle({ tabId, title: null });
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
	if (queued <= 0) return setGlobal('', '#6b7280', 'Save to Pigeon');
	await setGlobal(String(queued), '#b45309', `${reason ? `${reason}. ` : ''}${waiting(queued)}`);
}

// A service worker restart is a good moment to retry.
void readQueue(deps.store).then((queue) => {
	if (queue.length > 0) void retryQueued();
});
