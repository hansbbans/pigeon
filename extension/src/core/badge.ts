/**
 * The toolbar badge. Each tab normally shows the global badge (how many saves
 * are waiting); a save shows its own state on its tab for a few seconds, then
 * the tab goes back to the global one.
 *
 * Chrome resets a tab's badge text with null, but has no reset for a tab's
 * colour or tooltip. So clearing copies the global ones onto the tab, and the
 * tab is remembered (in storage.session) so every later global change is
 * copied onto it too; a copy never goes stale.
 */

import type { KeyValueStore } from './session';

/** The `action` calls used here (Chrome's, through webextension-polyfill). */
export interface ActionApi {
	setBadgeText(details: { tabId?: number; text: string | null }): Promise<void>;
	setBadgeBackgroundColor(details: { tabId?: number; color: string | [number, number, number, number] }): Promise<void>;
	getBadgeBackgroundColor(details: { tabId?: number }): Promise<[number, number, number, number] | string>;
	setTitle(details: { tabId?: number; title: string }): Promise<void>;
	getTitle(details: { tabId?: number }): Promise<string>;
}

export const DEFAULT_TITLE = 'Save to Pigeon';
export const DEFAULT_COLOR = '#6b7280';
export const WAITING_COLOR = '#b45309';
const COPIED_TABS_KEY = 'pigeonBadgeCopiedTabs';

export function waiting(count: number): string {
	return count === 1 ? '1 save is waiting.' : `${count} saves are waiting.`;
}

export class Badge {
	/** Per tab: bumped on every change, so an old timer cannot clear a newer state. */
	private readonly generation = new Map<number, number>();
	private lock: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly action: ActionApi,
		private readonly session: KeyValueStore,
		// Wrapped: calling the browser's setTimeout as a method of this object throws "Illegal invocation".
		private readonly schedule: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
	) {}

	/** Shows a state on one tab, then hands the tab back to the global badge. */
	async showOnTab(tabId: number | undefined, text: string, color: string, title: string, clearAfterMs?: number): Promise<void> {
		if (tabId === undefined) return this.setGlobal(text, color, title);
		const generation = (this.generation.get(tabId) ?? 0) + 1;
		this.generation.set(tabId, generation);
		// The tab has its own state now; global changes must not overwrite it.
		await this.updateCopiedTabs((tabs) => tabs.delete(tabId));
		try {
			await this.action.setBadgeBackgroundColor({ tabId, color });
			await this.action.setBadgeText({ tabId, text });
			await this.action.setTitle({ tabId, title });
		} catch {
			return; // The tab closed meanwhile.
		}
		if (clearAfterMs !== undefined) {
			this.schedule(() => {
				if (this.generation.get(tabId) === generation) void this.clearTab(tabId);
			}, clearAfterMs);
		}
	}

	/** Puts the tab back on the global badge and keeps it in step from now on. */
	async clearTab(tabId: number): Promise<void> {
		this.generation.delete(tabId);
		try {
			const [color, title] = await Promise.all([this.action.getBadgeBackgroundColor({}), this.action.getTitle({})]);
			await this.action.setBadgeText({ tabId, text: null });
			await this.action.setBadgeBackgroundColor({ tabId, color });
			await this.action.setTitle({ tabId, title });
			await this.updateCopiedTabs((tabs) => tabs.add(tabId));
		} catch {
			await this.updateCopiedTabs((tabs) => tabs.delete(tabId));
		}
	}

	forgetTab(tabId: number): Promise<unknown> {
		this.generation.delete(tabId);
		return this.updateCopiedTabs((tabs) => tabs.delete(tabId));
	}

	/** The badge every tab shows by default: how many saves are waiting. */
	setQueued(count: number, reason?: string): Promise<void> {
		if (count <= 0) return this.setGlobal('', DEFAULT_COLOR, DEFAULT_TITLE);
		return this.setGlobal(String(count), WAITING_COLOR, `${reason ? `${reason}. ` : ''}${waiting(count)}`);
	}

	private async setGlobal(text: string, color: string, title: string): Promise<void> {
		await this.action.setBadgeBackgroundColor({ color });
		await this.action.setBadgeText({ text });
		await this.action.setTitle({ title });
		for (const tabId of await this.updateCopiedTabs(() => undefined)) {
			try {
				await this.action.setBadgeBackgroundColor({ tabId, color });
				await this.action.setTitle({ tabId, title });
			} catch {
				await this.updateCopiedTabs((tabs) => tabs.delete(tabId));
			}
		}
	}

	/** Read-modify-write of the copied-tab list, one at a time. */
	private updateCopiedTabs(change: (tabs: Set<number>) => void): Promise<number[]> {
		const run = this.lock.then(async () => {
			const stored = (await this.session.get(COPIED_TABS_KEY))[COPIED_TABS_KEY];
			const tabs = new Set<number>(Array.isArray(stored) ? stored.filter((id): id is number => typeof id === 'number') : []);
			const before = tabs.size;
			const had = [...tabs].join(',');
			change(tabs);
			if (tabs.size !== before || [...tabs].join(',') !== had) await this.session.set({ [COPIED_TABS_KEY]: [...tabs] });
			return [...tabs];
		});
		this.lock = run.catch(() => undefined);
		return run;
	}
}
