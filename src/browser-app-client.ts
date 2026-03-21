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
	heroImageUrl: string | null;
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
				heroImageUrl: null,
				isLoaded: false,
			};
		}

		return {
			id: itemId,
			title: loadedItem.title,
			feedTitle: loadedItem.origin?.title ?? '',
			published: loadedItem.published,
			preview: loadedItem.summary?.content ?? '',
			heroImageUrl: selectArticleHeroImageUrl(loadedItem.content?.content),
			isLoaded: true,
		};
	});
}

export function selectArticleHeroImageUrl(articleHtml: string | undefined): string | null {
	if (!articleHtml) {
		return null;
	}

	function decodeHtmlAttribute(value: string): string {
		return value.replace(/&(#x?[0-9a-f]+|amp|apos|quot|lt|gt);/gi, (match, entity: string) => {
			const normalizedEntity = entity.toLowerCase();
			switch (normalizedEntity) {
				case 'amp':
					return '&';
				case 'apos':
					return "'";
				case 'quot':
					return '"';
				case 'lt':
					return '<';
				case 'gt':
					return '>';
				default: {
					const isHex = normalizedEntity.startsWith('#x');
					const isNumeric = normalizedEntity.startsWith('#');
					if (!isNumeric) {
						return match;
					}

					const codePoint = Number.parseInt(
						normalizedEntity.slice(isHex ? 2 : 1),
						isHex ? 16 : 10,
					);
					return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
				}
			}
		});
	}

	function readImageAttributes(imageTag: string): Record<string, string> {
		const attributes: Record<string, string> = {};
		const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
		for (const match of imageTag.matchAll(attributePattern)) {
			const attributeName = match[1].toLowerCase();
			if (attributeName === 'img') {
				continue;
			}
			attributes[attributeName] = decodeHtmlAttribute((match[2] ?? match[3] ?? match[4] ?? '').trim());
		}
		return attributes;
	}

	function isTrackerSized(value: string | undefined): boolean {
		if (!value) {
			return false;
		}
		const numeric = Number.parseFloat(value);
		return Number.isFinite(numeric) && numeric <= 1;
	}

	function isHiddenStyle(style: string | undefined): boolean {
		if (!style) {
			return false;
		}
		return /(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?|(?:width|max-width|height|max-height)\s*:\s*0(?:px)?)/i.test(
			style,
		);
	}
	const imageTagPattern = /<img\b[^>]*>/gi;

	for (const tagMatch of articleHtml.matchAll(imageTagPattern)) {
		const imageTag = tagMatch[0];
		const attributes = readImageAttributes(imageTag);
		if (
			'hidden' in attributes ||
			isTrackerSized(attributes.width) ||
			isTrackerSized(attributes.height) ||
			isHiddenStyle(attributes.style)
		) {
			continue;
		}

		const candidate = attributes.src?.trim() ?? '';
		if (/^(https?:)?\/\//i.test(candidate)) {
			return candidate;
		}
	}

	return null;
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
function __name(target) { return target; }
${extractAuthToken.toString()}
${createLoggedOutSession.toString()}
${createSessionFromToken.toString()}
${applyUnauthorizedState.toString()}
${sortSubscriptionsByTitle.toString()}
${buildFeedViews.toString()}
${limitInitialItemIds.toString()}
${createContentLoadPlan.toString()}
${buildArticleListEntries.toString()}
${selectArticleHeroImageUrl.toString()}
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
  selectArticleHeroImageUrl,
  normalizeBrowserItemId,
};
`.trim();
}
