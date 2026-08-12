export const AUTH_STORAGE_KEY = 'pigeon.browser.auth';
export const THEME_STORAGE_KEY = 'pigeon.browser.theme';
export const INITIAL_ITEM_ID_LIMIT = 50;
export const CONTENT_CHUNK_SIZE = 20;
export type BrowserTheme = 'light' | 'dark';

export interface BrowserAppSession {
	status: 'logged_out' | 'authenticated';
	token: string | null;
}

export interface BrowserSubscription {
	id: string;
	title: string;
	iconUrl?: string;
	categories?: Array<{
		id: string;
		label?: string;
	}>;
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
	kind: 'all' | 'unread' | 'today' | 'recent' | 'folder' | 'feed';
	section: 'views' | 'folders' | 'feeds';
	iconUrl?: string;
	parentId?: string;
}

export interface BrowserLocalDayBounds {
	startSeconds: number;
	endSeconds: number;
}

export interface BrowserLoadedItem {
	id: string;
	title: string;
	published: number;
	origin?: {
		title?: string;
	};
	alternate?: Array<{
		href?: string;
	}>;
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

export function normalizeBrowserTheme(value: string | null | undefined): BrowserTheme {
	return value === 'dark' ? 'dark' : 'light';
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

export function createArticleFrameDocument(
	articleHtml: string | undefined,
	theme: BrowserTheme = 'light',
): string {
	const articleBody =
		articleHtml && articleHtml.trim() ? articleHtml : '<p class="pigeon-empty">No article content available.</p>';
	const resolvedTheme = normalizeBrowserTheme(theme);

	return `<!doctype html>
<html lang="en" data-theme="${resolvedTheme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base target="_blank" />
    <style>
      :root {
        color-scheme: light;
        --frame-page: #ffffff;
        --frame-text: #1f2937;
        --frame-link: #0f5cc0;
        --frame-link-hover: #0a4a9a;
        --frame-border: #d8dee6;
        --frame-pre: #f8fafc;
        --frame-quote: #4b5563;
        --frame-muted: #6b7280;
      }

      html[data-theme="dark"] {
        color-scheme: dark;
        --frame-page: #0f172a;
        --frame-text: #e5e7eb;
        --frame-link: #8ab4ff;
        --frame-link-hover: #bfd3ff;
        --frame-border: #334155;
        --frame-pre: #111827;
        --frame-quote: #cbd5e1;
        --frame-muted: #94a3b8;
      }

      html {
        background: var(--frame-page);
      }

      body {
        margin: 0;
        padding: 32px 36px 48px;
        background: var(--frame-page);
        color: var(--frame-text);
        font: 16px/1.7 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        word-break: break-word;
        overflow-wrap: anywhere;
      }

      body > * {
        max-width: 46rem;
        margin-right: auto;
        margin-left: auto;
      }

      article,
      main,
      section,
      div,
      table,
      pre,
      blockquote {
        max-width: 46rem;
      }

      p,
      li,
      blockquote,
      figcaption {
        font-size: 1rem;
      }

      a {
        color: var(--frame-link);
        text-decoration: underline;
        text-decoration-thickness: 0.08em;
        text-underline-offset: 0.14em;
      }

      a:hover {
        color: var(--frame-link-hover);
      }

      img,
      video,
      iframe,
      table,
      pre {
        max-width: 100%;
      }

      img,
      video,
      iframe {
        height: auto;
      }

      pre,
      code {
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
      }

      pre {
        overflow-x: auto;
        padding: 16px;
        border: 1px solid var(--frame-border);
        background: var(--frame-pre);
        white-space: pre-wrap;
      }

      blockquote {
        margin: 1.25rem auto;
        padding-left: 1rem;
        border-left: 3px solid var(--frame-border);
        color: var(--frame-quote);
      }

      .pigeon-empty {
        color: var(--frame-muted);
      }
    </style>
  </head>
  <body>${articleBody}</body>
</html>`;
}

export function buildFeedViews(
	subscriptions: BrowserSubscription[],
	unreadCounts: BrowserUnreadCount[],
): BrowserFeedView[] {
	function createCategoryLabel(category: { id: string; label?: string }): string {
		if (category.label && category.label.trim()) {
			return category.label.trim();
		}

		const labelPrefix = 'user/-/label/';
		if (category.id.startsWith(labelPrefix)) {
			return category.id.slice(labelPrefix.length);
		}

		return category.id;
	}

	function sortCategories(categories: Array<{ id: string; label?: string }>): Array<{ id: string; label?: string }> {
		return [...categories].sort((left, right) => {
			const byLabel = createCategoryLabel(left).localeCompare(createCategoryLabel(right), undefined, {
				sensitivity: 'base',
				numeric: true,
			});
			if (byLabel !== 0) {
				return byLabel;
			}
			return left.id.localeCompare(right.id);
		});
	}

	const feedUnreadCounts = unreadCounts.filter((entry) => entry.id.startsWith('feed/'));
	const unreadCountById = new Map(feedUnreadCounts.map((entry) => [entry.id, entry.count]));
	const unreadCountByStreamId = new Map(unreadCounts.map((entry) => [entry.id, entry.count]));
	const totalUnreadCount =
		unreadCounts.find((entry) => entry.id === 'user/-/state/com.google/reading-list')?.count ??
		feedUnreadCounts.reduce((sum, entry) => sum + entry.count, 0);
	const sortedSubscriptions = sortSubscriptionsByTitle(subscriptions);
	const folderUnreadCountById = new Map<string, number>();
	const folderViewMap = new Map<string, BrowserFeedView>();
	const feedViews: BrowserFeedView[] = [];

	for (const subscription of sortedSubscriptions) {
		const subscriptionCategories = sortCategories(
			(subscription.categories || []).filter(
				(category, index, categories) =>
					category &&
					typeof category.id === 'string' &&
					category.id.trim() &&
					categories.findIndex((candidate) => candidate?.id === category.id) === index,
			),
		);
		for (const category of subscriptionCategories) {
			folderUnreadCountById.set(
				category.id,
				(folderUnreadCountById.get(category.id) ?? 0) + (unreadCountById.get(subscription.id) ?? 0),
			);
			const existingFolderView = folderViewMap.get(category.id);
			if (!existingFolderView) {
				folderViewMap.set(category.id, {
					id: category.id,
					title: createCategoryLabel(category),
					streamId: category.id,
					unreadCount: 0,
					kind: 'folder',
					section: 'folders',
				});
			}
		}
		if (subscriptionCategories.length === 0) {
			feedViews.push({
				id: subscription.id,
				title: subscription.title,
				streamId: subscription.id,
				unreadCount: unreadCountById.get(subscription.id) ?? 0,
				kind: 'feed',
				section: 'feeds',
				...(subscription.iconUrl ? { iconUrl: subscription.iconUrl } : {}),
			});
			continue;
		}

		for (const category of subscriptionCategories) {
			feedViews.push({
				id: subscriptionCategories.length > 1 ? `${subscription.id}::${category.id}` : subscription.id,
				title: subscription.title,
				streamId: subscription.id,
				unreadCount: unreadCountById.get(subscription.id) ?? 0,
				kind: 'feed',
				section: 'folders',
				parentId: category.id,
				...(subscription.iconUrl ? { iconUrl: subscription.iconUrl } : {}),
			});
		}
	}

	for (const folderView of folderViewMap.values()) {
		folderView.unreadCount = unreadCountByStreamId.get(folderView.id) ?? folderUnreadCountById.get(folderView.id) ?? 0;
	}

	const folderViews = [...folderViewMap.values()].sort((left, right) => {
		const byTitle = left.title.localeCompare(right.title, undefined, {
			sensitivity: 'base',
			numeric: true,
		});
		if (byTitle !== 0) {
			return byTitle;
		}
		return left.id.localeCompare(right.id);
	});

	return [
		{
			id: 'all',
			title: 'All items',
			streamId: 'user/-/state/com.google/reading-list',
			unreadCount: totalUnreadCount,
			kind: 'all',
			section: 'views',
		},
		{
			id: 'unread',
			title: 'Unread',
			streamId: 'user/-/state/com.google/reading-list',
			unreadCount: totalUnreadCount,
			kind: 'unread',
			section: 'views',
		},
		{
			id: 'today',
			title: 'Today',
			streamId: 'user/-/state/com.google/reading-list',
			unreadCount: 0,
			kind: 'today',
			section: 'views',
		},
		{
			id: 'recent',
			title: 'Recently read',
			streamId: 'user/-/state/com.google/read',
			unreadCount: 0,
			kind: 'recent',
			section: 'views',
		},
		...folderViews,
		...feedViews,
	];
}

export function getLocalDayBounds(now: Date = new Date()): BrowserLocalDayBounds {
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

	return {
		startSeconds: Math.floor(start.getTime() / 1000),
		endSeconds: Math.floor(end.getTime() / 1000),
	};
}

export function filterItemIdsForLocalDay(
	itemIds: string[],
	loadedItemsById: Record<string, Pick<BrowserLoadedItem, 'published'>>,
	now: Date = new Date(),
): string[] {
	const bounds = getLocalDayBounds(now);
	return itemIds.filter((itemId) => {
		const published = loadedItemsById[itemId]?.published;
		return (
			typeof published === 'number' &&
			Number.isFinite(published) &&
			published >= bounds.startSeconds &&
			published < bounds.endSeconds
		);
	});
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
			preview: createArticlePreview(loadedItem),
			heroImageUrl: selectArticleHeroImageUrl(loadedItem.content?.content),
			isLoaded: true,
		};
	});
}

function createArticlePreview(loadedItem: BrowserLoadedItem): string {
	const summaryContent = loadedItem.summary?.content ?? '';
	if (summaryContent) {
		const preview = cleanArticlePreviewText(
			looksLikeHtmlPreview(summaryContent) ? stripArticlePreviewMarkup(summaryContent) : summaryContent,
		);
		if (preview) {
			return preview;
		}
	}

	const source = loadedItem.content?.content ?? '';
	if (!source) {
		return '';
	}

	const decoded = source
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]+>/g, ' ');

	return cleanArticlePreviewText(decoded);
}

function looksLikeHtmlPreview(value: string): boolean {
	const trimmed = value.trim();
	return /^<[a-z][\s>]/i.test(trimmed) || /<\/(?:article|blockquote|div|h[1-6]|li|main|ol|p|section|span|table|td|tr|ul)>/i.test(value);
}

function stripArticlePreviewMarkup(value: string): string {
	return decodeArticlePreviewEntities(value)
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]+>/g, ' ');
}

function cleanArticlePreviewText(value: string): string {
	const decoded = decodeArticlePreviewEntities(value)
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
		.replace(/[\u00ad\u034f\u180e\u200b\u2060\ufeff]/g, '')
		.replace(/\p{Zs}/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	if (decoded.length <= 280) {
		return decoded;
	}

	return `${decoded.slice(0, 277).trimEnd()}...`;
}

function decodeArticlePreviewEntities(value: string): string {
	let decoded = value;
	for (let pass = 0; pass < 2; pass += 1) {
		const next = decoded
			.replace(/&nbsp;/gi, ' ')
			.replace(/&amp;/gi, '&')
			.replace(/&quot;/gi, '"')
			.replace(/&#39;|&apos;/gi, "'")
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safePreviewCodePoint(Number.parseInt(hex, 16)))
			.replace(/&#([0-9]+);/g, (_match, decimal: string) => safePreviewCodePoint(Number.parseInt(decimal, 10)));

		if (next === decoded) {
			return decoded;
		}
		decoded = next;
	}
	return decoded;
}

function safePreviewCodePoint(value: number): string {
	if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) {
		return '';
	}

	try {
		return String.fromCodePoint(value);
	} catch {
		return '';
	}
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
					return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
						? String.fromCodePoint(codePoint)
						: match;
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
${normalizeBrowserTheme.toString()}
${applyUnauthorizedState.toString()}
${sortSubscriptionsByTitle.toString()}
${buildFeedViews.toString()}
${getLocalDayBounds.toString()}
${filterItemIdsForLocalDay.toString()}
${limitInitialItemIds.toString()}
${createContentLoadPlan.toString()}
${safePreviewCodePoint.toString()}
${decodeArticlePreviewEntities.toString()}
${looksLikeHtmlPreview.toString()}
${stripArticlePreviewMarkup.toString()}
${cleanArticlePreviewText.toString()}
${createArticlePreview.toString()}
${buildArticleListEntries.toString()}
${createArticleFrameDocument.toString()}
${selectArticleHeroImageUrl.toString()}
${normalizeBrowserItemId.toString()}

window.__PIGEON_BROWSER_CLIENT__ = {
  AUTH_STORAGE_KEY: ${JSON.stringify(AUTH_STORAGE_KEY)},
  THEME_STORAGE_KEY: ${JSON.stringify(THEME_STORAGE_KEY)},
  INITIAL_ITEM_ID_LIMIT: ${INITIAL_ITEM_ID_LIMIT},
  CONTENT_CHUNK_SIZE: ${CONTENT_CHUNK_SIZE},
  extractAuthToken,
  createLoggedOutSession,
  createSessionFromToken,
  normalizeBrowserTheme,
  applyUnauthorizedState,
  sortSubscriptionsByTitle,
  buildFeedViews,
  getLocalDayBounds,
  filterItemIdsForLocalDay,
  limitInitialItemIds,
  createContentLoadPlan,
  buildArticleListEntries,
  createArticleFrameDocument,
  selectArticleHeroImageUrl,
  normalizeBrowserItemId,
};
`.trim();
}
