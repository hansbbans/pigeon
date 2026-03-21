export const AUTH_STORAGE_KEY = 'pigeon.browser.auth';
export const INITIAL_ITEM_ID_LIMIT = 50;
export const CONTENT_CHUNK_SIZE = 20;

export interface BrowserAppSession {
	status: 'logged_out' | 'authenticated';
	token: string | null;
}

export interface BrowserSubscription {
	id: string;
	title: string;
	iconUrl?: string;
}

export interface BrowserUnreadCount {
	id: string;
	count: number;
}

export interface BrowserFeedView {
	id: string;
	title: string;
	streamId: string;
	unreadCount: number;
	kind: 'all' | 'unread' | 'feed';
	iconUrl?: string;
}

export interface BrowserLoadedItem {
	id: string;
	title: string;
	published: number;
	origin?: {
		title?: string;
	};
	summary?: {
		content?: string;
	};
	content?: {
		content?: string;
	};
}

export interface BrowserArticleListEntry {
	id: string;
	title: string;
	feedTitle: string;
	published: number;
	preview: string;
	isLoaded: boolean;
}

export function extractAuthToken(responseText: string): string | null {
	const match = responseText.match(/^Auth=pigeon\/(.+)$/m);
	return match?.[1] ?? null;
}

export function createLoggedOutSession(): BrowserAppSession {
	return {
		status: 'logged_out',
		token: null,
	};
}

export function createSessionFromToken(token: string): BrowserAppSession {
	return {
		status: 'authenticated',
		token,
	};
}

export function applyUnauthorizedState(_session: BrowserAppSession): BrowserAppSession {
	return createLoggedOutSession();
}

export function sortSubscriptionsByTitle(subscriptions: BrowserSubscription[]): BrowserSubscription[] {
	return [...subscriptions].sort((left, right) => {
		const byTitle = left.title.localeCompare(right.title, undefined, {
			sensitivity: 'base',
			numeric: true,
		});
		if (byTitle !== 0) {
			return byTitle;
		}
		return left.id.localeCompare(right.id);
	});
}

export function buildFeedViews(
	subscriptions: BrowserSubscription[],
	unreadCounts: BrowserUnreadCount[],
): BrowserFeedView[] {
	const unreadCountById = new Map(unreadCounts.map((entry) => [entry.id, entry.count]));
	const totalUnreadCount = unreadCounts.reduce((sum, entry) => sum + entry.count, 0);
	const sortedSubscriptions = sortSubscriptionsByTitle(subscriptions);

	return [
		{
			id: 'all',
			title: 'All items',
			streamId: 'user/-/state/com.google/reading-list',
			unreadCount: totalUnreadCount,
			kind: 'all',
		},
		{
			id: 'unread',
			title: 'Unread',
			streamId: 'user/-/state/com.google/reading-list',
			unreadCount: totalUnreadCount,
			kind: 'unread',
		},
		...sortedSubscriptions.map((subscription) => ({
			id: subscription.id,
			title: subscription.title,
			streamId: subscription.id,
			unreadCount: unreadCountById.get(subscription.id) ?? 0,
			kind: 'feed' as const,
			...(subscription.iconUrl ? { iconUrl: subscription.iconUrl } : {}),
		})),
	];
}

export function limitInitialItemIds(itemIds: string[]): string[] {
	return itemIds.slice(0, INITIAL_ITEM_ID_LIMIT);
}

export function createContentLoadPlan(options: {
	itemIds: string[];
	loadedItemIds: string[];
	selectedItemId?: string | null;
}): string[] {
	const loadedIds = new Set(options.loadedItemIds);
	const plannedIds: string[] = [];

	const addId = (itemId: string | null | undefined) => {
		if (!itemId || loadedIds.has(itemId) || plannedIds.includes(itemId) || !options.itemIds.includes(itemId)) {
			return;
		}
		plannedIds.push(itemId);
	};

	addId(options.selectedItemId ?? null);

	for (const itemId of options.itemIds) {
		addId(itemId);
		if (plannedIds.length >= CONTENT_CHUNK_SIZE) {
			break;
		}
	}

	return plannedIds;
}

export function buildArticleListEntries(options: {
	itemIds: string[];
	loadedItemsById: Record<string, BrowserLoadedItem>;
}): BrowserArticleListEntry[] {
	return options.itemIds.map((itemId) => {
		const loadedItem = options.loadedItemsById[itemId];
		if (!loadedItem) {
			return {
				id: itemId,
				title: 'Loading article…',
				feedTitle: '',
				published: 0,
				preview: '',
				isLoaded: false,
			};
		}

		return {
			id: itemId,
			title: loadedItem.title,
			feedTitle: loadedItem.origin?.title ?? '',
			published: loadedItem.published,
			preview: loadedItem.summary?.content ?? '',
			isLoaded: true,
		};
	});
}

export function normalizeBrowserItemId(itemId: string): string {
	const prefix = 'tag:google.com,2005:reader/item/';
	if (itemId.startsWith(prefix)) {
		return parseInt(itemId.slice(prefix.length), 16).toString(10);
	}
	return itemId;
}

export function renderBrowserAppClientScript(): string {
	return `
${extractAuthToken.toString()}
${createLoggedOutSession.toString()}
${createSessionFromToken.toString()}
${applyUnauthorizedState.toString()}
${sortSubscriptionsByTitle.toString()}
${buildFeedViews.toString()}
${limitInitialItemIds.toString()}
${createContentLoadPlan.toString()}
${buildArticleListEntries.toString()}
${normalizeBrowserItemId.toString()}

window.__PIGEON_BROWSER_CLIENT__ = {
  AUTH_STORAGE_KEY: ${JSON.stringify(AUTH_STORAGE_KEY)},
  INITIAL_ITEM_ID_LIMIT: ${INITIAL_ITEM_ID_LIMIT},
  CONTENT_CHUNK_SIZE: ${CONTENT_CHUNK_SIZE},
  extractAuthToken,
  createLoggedOutSession,
  createSessionFromToken,
  applyUnauthorizedState,
  sortSubscriptionsByTitle,
  buildFeedViews,
  limitInitialItemIds,
  createContentLoadPlan,
  buildArticleListEntries,
  normalizeBrowserItemId,
};
`.trim();
}
