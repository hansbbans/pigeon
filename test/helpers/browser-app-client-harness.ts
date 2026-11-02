// Shared fixtures and DOM harness for the browser-app-client test files.
// Not a test file itself: it lives outside the test/*.test.ts glob.
import * as assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
	AUTH_STORAGE_KEY,
	THEME_STORAGE_KEY,
	getLocalDayBounds,
	normalizeBrowserItemId,
	renderBrowserAppClientScript,
} from '../../src/browser-app-client';
import { renderBrowserAppRuntimeScript } from '../../src/browser-app';
import { handleGreaderRequest } from '../../src/greader';
import { handleNativeApiRequest } from '../../src/native-api';
import { renderBrowserPersonalizationScript } from '../../src/browser-personalization';
import { renderBrowserLibraryManagementScript } from '../../src/browser-library-management';
import { generateApiToken } from '../../src/api-auth';

export function createElement(
	initialValue = '',
	initialClasses: string[] = [],
	tagName = 'div',
	onFocus?: (element: ReturnType<typeof createElement>) => void,
	onReveal?: (id: string, options: { block?: string; inline?: string }) => void,
) {
	const handlers = new Map<string, (event: Record<string, unknown> & { preventDefault(): void; target: unknown }) => unknown>();
	const classes = new Set(initialClasses);
	const attributes = new Map<string, string>();
	const styleProperties = new Map<string, string>();
	const dataset: Record<string, string> = {};
	const children: Array<ReturnType<typeof createElement>> = [];
	let ownTextContent = '';
	let innerHtmlValue = '';
	const element = {
		tagName: tagName.toUpperCase(),
		value: initialValue,
		scrollTop: 0,
		scrollHeight: 0,
		clientHeight: 0,
		srcdoc: '',
		disabled: false,
		hidden: false,
		isContentEditable: false,
		parentElement: null as ReturnType<typeof createElement> | null,
		dataset,
		children,
		style: {
			setProperty(name: string, value: string) {
				styleProperties.set(name, value);
			},
			getPropertyValue(name: string) {
				return styleProperties.get(name) ?? '';
			},
			removeProperty(name: string) {
				styleProperties.delete(name);
			},
		},
		toggleCalls: [] as Array<{ name: string; force: boolean | undefined }>,
		classList: {
			add(...names: string[]) {
				for (const name of names) {
					classes.add(name);
				}
			},
			remove(...names: string[]) {
				for (const name of names) {
					classes.delete(name);
				}
			},
			toggle(name: string, force?: boolean) {
				element.toggleCalls.push({ name, force });
				if (force === true) {
					classes.add(name);
					return true;
				}
				if (force === false) {
					classes.delete(name);
					return false;
				}
				if (classes.has(name)) {
					classes.delete(name);
					return false;
				}
				classes.add(name);
				return true;
			},
			contains(name: string) {
				return classes.has(name);
			},
		},
		appendChild(child: ReturnType<typeof createElement>) {
			child.parentElement = element;
			children.push(child);
			return child;
		},
		append(...nodes: Array<ReturnType<typeof createElement>>) {
			for (const node of nodes) { node.parentElement = element; children.push(node); }
		},
		get childElementCount() { return children.length; },
		querySelectorAll(selector: string): Array<ReturnType<typeof createElement>> {
			const tags = selector.split(',').map((tag) => tag.toUpperCase());
			return children.flatMap((child) => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
		},
		replaceChildren(...newChildren: Array<ReturnType<typeof createElement>>) {
			children.length = 0;
			for (const child of newChildren) {
				child.parentElement = element;
				children.push(child);
			}
		},
		setAttribute(name: string, value: string) {
			attributes.set(name, value);
			if (name === 'contenteditable') {
				element.isContentEditable = value !== 'false';
			}
			if (name.startsWith('data-')) {
				dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
			}
		},
		getAttribute(name: string) {
			return attributes.get(name) ?? null;
		},
		addEventListener(type: string, handler: (event: Record<string, unknown> & { preventDefault(): void }) => unknown) {
			handlers.set(type, handler);
		},
		removeEventListener(type: string) {
			handlers.delete(type);
		},
		hasEventListener(type: string) {
			return handlers.has(type);
		},
		dispatch(type: string, event?: Record<string, unknown>) {
			const handler = handlers.get(type);
			if (handler) {
				return handler({ preventDefault() {}, target: element, currentTarget: element, ...event });
			}
			return undefined;
		},
		focus() {
			onFocus?.(element);
		},
		scrollIntoViewCalls: [] as Array<{ block?: string; inline?: string }>,
		scrollIntoView(options: { block?: string; inline?: string }) { element.scrollIntoViewCalls.push(options); onReveal?.(dataset.itemId ?? '', options); },
		setPointerCapture() {},
		getBoundingClientRect() {
			return { width: 1440, height: 900, left: 0, right: 1440, top: 0, bottom: 900 };
		},
	};

	Object.defineProperty(element, 'textContent', {
		get() {
			return ownTextContent + children.map((child) => child.textContent).join('');
		},
		set(value: string) {
			ownTextContent = value;
			children.length = 0;
		},
		enumerable: true,
		configurable: true,
	});

	Object.defineProperty(element, 'innerHTML', {
		get() {
			return innerHtmlValue;
		},
		set(value: string) {
			innerHtmlValue = value;
			children.length = 0;
		},
		enumerable: true,
		configurable: true,
	});

	return element;
}

export function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

export async function flushBrowserTasks() {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function waitForBrowserCondition(check: () => boolean, attempts = 20) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (check()) {
			return;
		}
		await flushBrowserTasks();
	}
	assert.ok(check(), `Browser condition was not met after ${attempts} attempts`);
}

export function createFixedDateConstructor(timestamp: number | (() => number)) {
	return class FixedDate extends Date {
		constructor(
			value?: string | number,
			month?: number,
			day?: number,
			hours?: number,
			minutes?: number,
			seconds?: number,
			milliseconds?: number,
		) {
			if (month === undefined) {
				super(value === undefined ? (typeof timestamp === 'function' ? timestamp() : timestamp) : value);
				return;
			}

			super(
				value as number,
				month,
				day ?? 1,
				hours ?? 0,
				minutes ?? 0,
				seconds ?? 0,
				milliseconds ?? 0,
			);
		}

		static now() {
			return typeof timestamp === 'function' ? timestamp() : timestamp;
		}
	};
}

export type HarnessFetch = (input: string, init?: { method?: string; body?: FormData; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

// First visits now ask for one `stream/contents` page. Fixtures written against
// the older ids + contents pair still describe the same server state, so when a
// fixture does not answer `stream/contents` itself, compose the page it would
// have produced from its ids and contents answers.
export function withLegacyMembershipFixtures(fetchImpl: HarnessFetch): HarnessFetch {
	const streamContentsPrefix = '/reader/api/0/stream/contents?';
	return async (input, init) => {
		if (!String(input).startsWith(streamContentsPrefix) || (init?.method && init.method !== 'GET')) return fetchImpl(input, init);
		let response: Response | null = null;
		try {
			response = await fetchImpl(input, init);
		} catch (error) {
			if (!(error instanceof Error && error.message.startsWith('Unexpected fetch'))) throw error;
		}
		if (response && response.status !== 404) return response;
		const idsResponse = await fetchImpl('/reader/api/0/stream/items/ids?' + String(input).slice(streamContentsPrefix.length), init);
		if (!idsResponse.ok) return idsResponse;
		const idsPayload = (await idsResponse.json()) as { itemRefs?: Array<{ id: string }>; continuation?: string };
		const ids = (idsPayload.itemRefs ?? []).map((itemRef) => String(itemRef.id));
		let items: unknown[] = [];
		if (ids.length > 0) {
			const body = new FormData();
			for (const id of ids) body.append('i', id);
			const contentsResponse = await fetchImpl('/reader/api/0/stream/items/contents', { ...init, method: 'POST', body });
			if (!contentsResponse.ok) return contentsResponse;
			const returned = ((await contentsResponse.json()) as { items?: Array<{ id: string }> }).items ?? [];
			const byId = new Map(returned.map((item) => [normalizeBrowserItemId(String(item.id)), item]));
			items = ids.map((id) => byId.get(id)).filter(Boolean);
		}
		return Response.json({ id: 'legacy', updated: 0, items, ...(idsPayload.continuation ? { continuation: idsPayload.continuation } : {}) });
	};
}

export async function createBrowserHarness(options?: {
	storedToken?: string | null;
	storedTheme?: string | null;
	storedArticleListMode?: string | null;
	storedAutoReadPolicy?: string | null;
	storedSidebarCollapsed?: string | null;
	offlineTools?: any;
	locationHref?: string;
	readingTools?: any;
	extractReader?: (html:string,url:string)=>any;
	frameScrollHeight?: number;
	frameViewportHeight?: number;
	storedColumnWidths?: { sidebar?: number; stream?: number };
	readerGridWidth?: number | (() => number);
	online?: boolean;
	now?: number | (() => number);
	fetchImpl?: (input: string, init?: { method?: string; body?: FormData; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
}) {
	const documentHandlers = new Map<string, (event: Record<string, unknown>) => unknown>();
	const windowHandlers = new Map<string, (event: Record<string, unknown>) => unknown>();
	let visibilityState = 'visible';
	let activeElement: ReturnType<typeof createElement> | null = null;
	const revealCalls: Array<{ id: string; block?: string; inline?: string }> = [];
	const registerFocus = (element: ReturnType<typeof createElement>) => {
		activeElement = element;
	};
	const elements = new Map<string, ReturnType<typeof createElement>>([
		['login-screen', createElement('', [], 'div', registerFocus)],
		['reader-shell', createElement('', ['hidden'], 'section', registerFocus)],
		['reader-grid', createElement('', [], 'div', registerFocus)],
		['sidebar-column-resizer', createElement('', [], 'button', registerFocus)],
		['stream-column-resizer', createElement('', [], 'button', registerFocus)],
		['reader-window-address', createElement('', [], 'div', registerFocus)],
		['login-form', createElement('', [], 'form', registerFocus)],
		['login-error', createElement('', [], 'div', registerFocus)],
		['password-input', createElement('secret-password', [], 'input', registerFocus)],
		['clear-session-button', createElement('', [], 'button', registerFocus)],
		['logout-button', createElement('', [], 'button', registerFocus)],
		['theme-toggle-button', createElement('', [], 'button', registerFocus)],
		['article-list-mode-button', createElement('', [], 'button', registerFocus)],
		['settings-button', createElement('', [], 'button', registerFocus)],
		['personalization-content', createElement('', [], 'section', registerFocus)],
		['offline-enable-button', createElement('', [], 'button', registerFocus)],
		['offline-sync-button', createElement('', [], 'button', registerFocus)],
		['offline-free-button', createElement('', [], 'button', registerFocus)],
		['offline-clear-button', createElement('', [], 'button', registerFocus)],
		['offline-clear-confirm', createElement('', [], 'input', registerFocus)],
		['offline-mode-banner', createElement('', ['hidden'], 'p', registerFocus)],
		['offline-status', createElement('', [], 'p', registerFocus)],
		['notifications-content', createElement('', [], 'section', registerFocus)],
		['notification-action-panel', createElement('', ['hidden'], 'div', registerFocus)],
		['notification-action-text', createElement('', [], 'p', registerFocus)],
		['notification-confirm-button', createElement('', [], 'button', registerFocus)],
		['notification-cancel-button', createElement('', [], 'button', registerFocus)],
		['reader-mode-select', createElement('newsletter', [], 'select', registerFocus)],
		['reader-reading-status', createElement('', [], 'p', registerFocus)],
		['load-images-button', createElement('', [], 'button', registerFocus)],
		['share-article-button', createElement('', [], 'button', registerFocus)],
		['readwise-token-input', createElement('', [], 'input', registerFocus)],
		['readwise-save-button', createElement('', [], 'button', registerFocus)],
		['image-zoom-panel', createElement('', ['hidden'], 'div', registerFocus)],
		['zoom-image', createElement('', [], 'img', registerFocus)],
		['close-image-zoom', createElement('', [], 'button', registerFocus)],
		['reading-settings-form', createElement('', [], 'form', registerFocus)],
		['refresh-view-button', createElement('', [], 'button', registerFocus)],
		['more-like-button', createElement('', [], 'button', registerFocus)],
		['not-interested-button', createElement('', [], 'button', registerFocus)],
		['settings-panel', createElement('', ['hidden'], 'aside', registerFocus)],
		['close-settings-button', createElement('', [], 'button', registerFocus)],
		['sidebar-current-title', createElement('', [], 'strong', registerFocus)],
		['sidebar-current-meta', createElement('', [], 'p', registerFocus)],
		['views-list', createElement('', [], 'ul', registerFocus)],
		['folders-status', createElement('', [], 'p', registerFocus)],
		['folders-list', createElement('', [], 'ul', registerFocus)],
		['feeds-status', createElement('', [], 'p', registerFocus)],
		['feeds-list', createElement('', [], 'ul', registerFocus)],
		['articles-heading', createElement('', [], 'strong', registerFocus)],
		['articles-status', createElement('', [], 'p', registerFocus)],
		['articles-list-shell', createElement('', [], 'div', registerFocus)],
		['articles-list', createElement('', [], 'ul', registerFocus)],
		['load-more-button', createElement('', ['hidden'], 'button', registerFocus)],
		['article-page-controls', createElement('', ['hidden'], 'div', registerFocus)],
		['article-newer-button', createElement('', [], 'button', registerFocus)],
		['article-older-button', createElement('', [], 'button', registerFocus)],
		['mark-all-as-read-button', createElement('', ['hidden'], 'button', registerFocus)],
		['reader-source-label', createElement('', [], 'p', registerFocus)],
		['reader-source-note', createElement('', [], 'p', registerFocus)],
		['open-original-button', createElement('', [], 'button', registerFocus)],
		['mark-unread-button', createElement('', [], 'button', registerFocus)],
		['star-article-button', createElement('', [], 'button', registerFocus)],
		['undo-article-button', createElement('', ['hidden'], 'button', registerFocus)],
		['auto-read-select', createElement('manual', [], 'select', registerFocus)],
		['reading-preference-status', createElement('', [], 'p', registerFocus)],
		['search-button', createElement('', [], 'button', registerFocus)],
		['article-query-controls', createElement('', [], 'div', registerFocus)],
		['app-theme-select', createElement('system', [], 'select', registerFocus)],
		['sidebar-toggle-button', createElement('', [], 'button', registerFocus)],
		['stream-back-button', createElement('', [], 'button', registerFocus)],
		['reader-back-button', createElement('', [], 'button', registerFocus)],
		['reader-copy', createElement('', [], 'div', registerFocus)],
		['reader-scroll', createElement('', [], 'div', registerFocus)],
		['article-options-menu', createElement('', [], 'details', registerFocus)],
		['article-actions-menu', createElement('', [], 'details', registerFocus)],
		['article-query-form', createElement('', [], 'form', registerFocus)],
		['article-search-input', createElement('', [], 'input', registerFocus)],
		['clear-article-search-button', createElement('', [], 'button', registerFocus)],
		['article-read-filter', createElement('all', [], 'select', registerFocus)],
		['article-sort-select', createElement('newest', [], 'select', registerFocus)],
		['article-bulk-select', createElement('above', [], 'select', registerFocus)],
		['article-bulk-button', createElement('', [], 'button', registerFocus)],
		['article-query-status', createElement('', [], 'p', registerFocus)],
		['article-context-menu', createElement('', ['hidden'], 'div', registerFocus)],
		['context-mark-above-button', createElement('', [], 'button', registerFocus)],
		['context-mark-below-button', createElement('', [], 'button', registerFocus)],
		['library-button', createElement('', [], 'button', registerFocus)],
		['library-panel', createElement('', ['hidden'], 'aside', registerFocus)],
		['close-library-button', createElement('', [], 'button', registerFocus)],
		['library-content', createElement('', [], 'div', registerFocus)],
		['reader-action-status', createElement('', [], 'p', registerFocus)],
		['reader-title', createElement('', [], 'strong', registerFocus)],
		['reader-meta', createElement('', [], 'p', registerFocus)],
		['reader-player-shell', createElement('', ['hidden'], 'section', registerFocus)],
		['reader-player-container', createElement('', [], 'div', registerFocus)],
		['reader-player-fallback', createElement('', [], 'a', registerFocus)],
		['reader-frame', createElement('', [], 'iframe', registerFocus)],
		['settings-content', createElement('', [], 'div', registerFocus)],
	]);
	const frameDocumentHandlers = new Map<string, (event: Record<string, unknown>) => unknown>();
	const frameBody = createElement('', [], 'body', registerFocus);
	const frameDocumentElement = createElement('', [], 'html', registerFocus);
	frameDocumentElement.scrollHeight = options?.frameScrollHeight ?? 0;
	frameDocumentElement.clientHeight = options?.frameViewportHeight ?? 0;
	const frameDocument = {
		body: frameBody,
		documentElement: frameDocumentElement,
		activeElement: frameBody,
		addEventListener(type: string, handler: (event: Record<string, unknown>) => unknown) {
			frameDocumentHandlers.set(type, handler);
		},
		removeEventListener(type: string) {
			frameDocumentHandlers.delete(type);
		},
		createElement(tagName?: string) {
			return createElement('', [], tagName, registerFocus, (id, options) => revealCalls.push({ id, ...options }));
		},
	};
	const storage = new Map<string, string>();
	const localStorageState = new Map<string, string>();
	const documentElementAttributes = new Map<string, string>();
	const innerHtmlWrites: string[] = [];
	if (options?.storedToken) {
		storage.set(AUTH_STORAGE_KEY, options.storedToken);
	}
	if (options?.storedTheme) {
		localStorageState.set(THEME_STORAGE_KEY, options.storedTheme);
	}
	if (options?.storedArticleListMode) {
		localStorageState.set('pigeon.browser.article-list-mode', options.storedArticleListMode);
	}
	if (options?.storedAutoReadPolicy) localStorageState.set('pigeon.browser.auto-read', options.storedAutoReadPolicy);
	if (options?.storedSidebarCollapsed) localStorageState.set('pigeon.browser.sidebar-collapsed', options.storedSidebarCollapsed);
	if (options?.storedColumnWidths) {
		localStorageState.set('pigeon.browser.column-widths', JSON.stringify(options.storedColumnWidths));
	}

	for (const [id, element] of elements) {
		let currentValue = '';
		Object.defineProperty(element, 'innerHTML', {
			get() {
				return currentValue;
			},
			set(value: string) {
				currentValue = value;
				innerHtmlWrites.push(id);
			},
			enumerable: true,
			configurable: true,
		});
	}

	const readerFrame = elements.get('reader-frame');
	if (!readerFrame) {
		throw new Error('Missing reader-frame element');
	}
	const readerGrid = elements.get('reader-grid');
	if (!readerGrid) {
		throw new Error('Missing reader-grid element');
	}
	readerGrid.getBoundingClientRect = () => {
		const widthOption = options?.readerGridWidth ?? 1440;
		const width = typeof widthOption === 'function' ? widthOption() : widthOption;
		return { width, height: 900, left: 0, right: width, top: 0, bottom: 900 };
	};
	let frameScrollY = 0;
	const readerFrameWindow = {
		document: frameDocument,
		get scrollY() {
			return frameScrollY;
		},
		scrollTo(_left: number, top: number) {
			frameScrollY = top;
			frameDocumentElement.scrollTop = top;
			frameBody.scrollTop = top;
		},
	};

	let currentSrcdoc = '';
	Object.defineProperty(readerFrame, 'srcdoc', {
		get() {
			return currentSrcdoc;
		},
		set(value: string) {
			currentSrcdoc = value;
			readerFrameWindow.scrollTo(0, 0);
			frameDocumentHandlers.clear();
			void setTimeout(() => {
				readerFrame.dispatch('load');
			}, 0);
		},
		enumerable: true,
		configurable: true,
	});

	Object.defineProperty(readerFrame, 'contentDocument', {
		get() {
			return frameDocument;
		},
		enumerable: true,
		configurable: true,
	});

	Object.defineProperty(readerFrame, 'contentWindow', {
		get() {
			return readerFrameWindow;
		},
		enumerable: true,
		configurable: true,
	});

	const context = {
		window: {
			__PIGEON_CONFIG__: { baseUrl: 'https://pigeon.example' },
			navigator: { onLine: options?.online ?? true },
			sessionStorage: {
				getItem(key: string) {
					return storage.get(key) ?? null;
				},
				setItem(key: string, value: string) {
					storage.set(key, value);
				},
				removeItem(key: string) {
					storage.delete(key);
				},
			},
			localStorage: {
				getItem(key: string) {
					return localStorageState.get(key) ?? null;
				},
				setItem(key: string, value: string) {
					localStorageState.set(key, value);
				},
				removeItem(key: string) {
					localStorageState.delete(key);
				},
			},
			__PIGEON_BROWSER_CLIENT__: undefined as unknown,
			__readArticleState: undefined as ((id: string) => { body: string[]; metadata: string[] }) | undefined,
			__readCacheSizes: undefined as (() => { bodies: number; metadata: number; active: number; queued: number; pending: number; paging: boolean; membership: number }) | undefined,
			open() {},
			addEventListener(type: string, handler: (event: Record<string, unknown>) => unknown) {
				windowHandlers.set(type, handler);
			},
			removeEventListener(type: string) {
				windowHandlers.delete(type);
			},
		},
		document: {
			get visibilityState() {
				return visibilityState;
			},
			documentElement: {
				setAttribute(name: string, value: string) {
					documentElementAttributes.set(name, value);
				},
			},
			addEventListener(type: string, handler: (event: Record<string, unknown>) => unknown) {
				documentHandlers.set(type, handler);
			},
			removeEventListener(type: string) {
				documentHandlers.delete(type);
			},
			get activeElement() {
				return activeElement;
			},
			createElement(tagName?: string) {
				return createElement('', [], tagName, registerFocus, (id, options) => revealCalls.push({ id, ...options }));
			},
			createTextNode(text: string) { const node = createElement(); node.textContent = text; return node; },
			getElementById(id: string) {
				const element = elements.get(id);
				if (!element) {
					throw new Error(`Unknown element: ${id}`);
				}
				return element;
			},
		},
		FormData,
		crypto,
		AbortController,
		Response,
		URL,
		URLSearchParams,
		Date: options?.now === undefined ? Date : createFixedDateConstructor(options.now),
		console,
		setTimeout,
		clearTimeout,
		fetch: withLegacyMembershipFixtures(options?.fetchImpl ?? (async () => new Response('Error=BadAuthentication', { status: 401 }))),
	};

	for(const key of ['theme','font','fontSize','lineHeight','width','margins','density','imagePolicy'])elements.set('reading-'+key,createElement('',[],key.includes('Size')?'input':'select',registerFocus));
	for(const key of ['next','previous','read','star'])elements.set('shortcut-'+key,createElement('',[],'input',registerFocus));
	elements.set('reading-settings-status',createElement('',[],'p',registerFocus));
	vm.runInNewContext(renderBrowserAppClientScript(), context);
	(context.window as any).document = context.document;
	(context.window as any).PigeonOffline = options?.offlineTools;
	(context.window as any).location=options?.locationHref?{href:options.locationHref}:undefined;
	(context.window as any).PigeonReading = options?.readingTools;
	(context.window as any).__PIGEON_READING_TOOLS__ = options?.extractReader ? {extract:options.extractReader} : undefined;
	(context as any).TextEncoder=TextEncoder;
	vm.runInNewContext(renderBrowserLibraryManagementScript(), context);
	vm.runInNewContext(renderBrowserPersonalizationScript(), context);
	const runtime = renderBrowserAppRuntimeScript().replace(/\}\)\(\);\s*$/, `
  window.__readCacheSizes = () => ({ bodies: articleCache.size, metadata: articleMetadataCache.size,
    active: activeContentRequestJobs.size, queued: contentRequestQueue.length, pending: inFlightContentIds.length, paging: isLoadingItemIdsPage, membership: inFlightMembershipRequests.size });
  window.__readArticleState = (id) => ({ body: articleCache.get(id)?.categories || [], metadata: articleMetadataCache.get(id)?.categories || [] });
})();`);
	vm.runInNewContext(runtime, context);
	await flushBrowserTasks();

	function dispatchKeydown(
		key: string,
		target: Record<string, unknown> = (activeElement ??
			elements.get('reader-shell')) as Record<string, unknown>,
		options?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
	) {
		const handler = documentHandlers.get('keydown');
		if (!handler) {
			throw new Error('No keydown handler registered');
		}

		let prevented = false;
		handler({
			key,
			target,
			metaKey: options?.metaKey ?? false,
			ctrlKey: options?.ctrlKey ?? false,
			altKey: options?.altKey ?? false,
			shiftKey: options?.shiftKey ?? false,
			preventDefault() {
				prevented = true;
			},
		});
		return prevented;
	}

	function dispatchFrameKeydown(
		key: string,
		target: Record<string, unknown> = frameBody as Record<string, unknown>,
		options?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
	) {
		const handler = frameDocumentHandlers.get('keydown');
		if (!handler) {
			throw new Error('No frame keydown handler registered');
		}

		let prevented = false;
		handler({
			key,
			target,
			metaKey: options?.metaKey ?? false,
			ctrlKey: options?.ctrlKey ?? false,
			altKey: options?.altKey ?? false,
			preventDefault() {
				prevented = true;
			},
		});
		return prevented;
	}

	function dispatchDocumentPointer(type: string, clientX: number) {
		const handler = documentHandlers.get(type);
		if (!handler) {
			throw new Error(`No ${type} handler registered`);
		}

		let prevented = false;
		handler({
			clientX,
			target: elements.get('reader-grid'),
			preventDefault() {
				prevented = true;
			},
		});
		return prevented;
	}

	function dispatchWindowEvent(type: string, event: Record<string, unknown> = {}) {
		const handler = windowHandlers.get(type);
		if (handler) {
			handler(event);
		}
	}

	function dispatchReaderFrameScroll(scrollTop: number) {
		readerFrameWindow.scrollTo(0, scrollTop);
		frameDocumentHandlers.get('scroll')?.({});
	}

	function dispatchDocumentEvent(type: string) {
			const handler = documentHandlers.get(type);
			if (handler) {
				handler({});
			}
	}

	function setVisibility(nextVisibility: string) {
		visibilityState = nextVisibility;
		dispatchDocumentEvent('visibilitychange');
	}

	function setOnline(nextOnline: boolean) {
		(context.window.navigator as { onLine: boolean }).onLine = nextOnline;
	}

	return {
		elements,
		getCacheSizes: () => context.window.__readCacheSizes!(),
		getCachedArticleState: (id: string) => JSON.parse(JSON.stringify(context.window.__readArticleState!(id))) as { body: string[]; metadata: string[] },
		revealCalls,
		storage,
		localStorageState,
		documentElementAttributes,
		innerHtmlWrites,
		dispatchKeydown,
		dispatchFrameKeydown,
		dispatchDocumentPointer,
		dispatchWindowEvent,
		dispatchReaderFrameScroll,
		getReaderFrameScrollTop() {
			return frameDocumentElement.scrollTop;
		},
		dispatchDocumentEvent,
		setVisibility,
		setOnline,
		getActiveElement() {
			return activeElement;
		},
	};
}

export function findListButtonByViewId(
	listElement: ReturnType<typeof createElement> | undefined,
	viewId: string,
) {
	for (const listItem of listElement?.children ?? []) {
		for (const child of listItem.children) {
			if (child.dataset.viewId === viewId) {
				return child;
			}
		}
	}
	return undefined;
}

export function findFolderToggleButton(
	listElement: ReturnType<typeof createElement> | undefined,
	folderId: string,
) {
	for (const listItem of listElement?.children ?? []) {
		for (const child of listItem.children) {
			if (child.getAttribute('data-folder-toggle-id') === folderId) {
				return child;
			}
		}
	}
	return undefined;
}

export function findListButtonByItemId(
	listElement: ReturnType<typeof createElement> | undefined,
	itemId: string,
) {
	for (const listItem of listElement?.children ?? []) {
		for (const child of listItem.children) {
			if (child.dataset.itemId === itemId) {
				return child;
			}
		}
	}
	return undefined;
}

export function findDescendantByClass(
	element: ReturnType<typeof createElement> | undefined,
	className: string,
): ReturnType<typeof createElement> | undefined {
	if (!element) {
		return undefined;
	}

	if (element.classList.contains(className)) {
		return element;
	}

	for (const child of element.children) {
		const match = findDescendantByClass(child, className);
		if (match) {
			return match;
		}
	}

	return undefined;
}

export function findDescendantByAttribute(
	element: ReturnType<typeof createElement> | undefined,
	name: string,
	value?: string,
): ReturnType<typeof createElement> | undefined {
	if (!element) {
		return undefined;
	}

	const attributeValue = element.getAttribute(name);
	if (attributeValue !== null && (value === undefined || attributeValue === value)) {
		return element;
	}

	for (const child of element.children) {
		const match = findDescendantByAttribute(child, name, value);
		if (match) {
			return match;
		}
	}

	return undefined;
}

export function browserRegressionItem(id: string, published: number) {
	return {
		id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
		title: `Article ${id}`,
		published,
		origin: { title: 'Alpha' },
		content: { content: `<p>Body ${id}</p>` },
	};
}

export function browserRegressionResponse(input: string, init?: { body?: FormData }, published = 1_742_460_800): Response {
	if (input === '/accounts/ClientLogin') return new Response('Auth=pigeon/live');
	if (input.endsWith('/subscription/list')) return Response.json({ subscriptions: [] });
	if (input.endsWith('/unread-count')) return Response.json({ unreadcounts: [] });
	if (input.endsWith('/contents')) {
		return Response.json({ items: (init?.body?.getAll('i') ?? []).map(String).map((id) => browserRegressionItem(id, published)) });
	}
	if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [] });
	throw new Error(`Unexpected fetch: ${input}`);
}

export async function createStatefulArticleBrowser(options?: {
	policy?: string; offlineTools?: any; locationHref?:string; readingTools?: any; extractReader?: (html:string,url:string)=>any; frameHeight?: number; viewportHeight?: number; count?: number;
	now?: number | (() => number);
	fetchOverride?: (input: string, init: RequestInit | undefined, next: () => Promise<Response>) => Promise<Response>;
}) {
	const browserNow = typeof options?.now === 'function' ? options.now() : options?.now ?? new Date(2026, 9, 12, 12).getTime();
	const state = createLargeTodaySqliteLibrary(browserNow, options?.count ?? 2);
	const token = await generateApiToken('today-test-password');
	const mutations: Array<{ itemId: string; itemIds: string[]; add: string | null; remove: string | null }> = [];
	const harness = await createBrowserHarness({
		now: options?.now ?? browserNow,
		storedAutoReadPolicy: options?.policy,
		readingTools:options?.readingTools,extractReader:options?.extractReader,offlineTools:options?.offlineTools,locationHref:options?.locationHref,
		frameScrollHeight: options?.frameHeight,
		frameViewportHeight: options?.viewportHeight,
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin') return new Response(`Auth=pigeon/${token}`);
			if (input.endsWith('/edit-tag')) mutations.push({ itemId: String(init?.body?.get('i')), itemIds: init?.body?.getAll('i').map(String) || [], add: init?.body?.get('a') as string | null, remove: init?.body?.get('r') as string | null });
			if (input.endsWith('/mutations')) {
				for (const mutation of JSON.parse(init?.body as unknown as string).mutations) {
					if (mutation.kind !== 'set_read_batch') continue;
					mutations.push({ itemId: mutation.itemIds[0], itemIds: mutation.itemIds,
						add: mutation.value ? 'user/-/state/com.google/read' : null,
						remove: mutation.value ? null : 'user/-/state/com.google/read' });
				}
			}
			const next = () => input.startsWith('/api/v1/')
				? handleNativeApiRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env)
				: handleGreaderRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env);
			return options?.fetchOverride ? options.fetchOverride(input, init as RequestInit, next) : next();
		},
	});
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story ' + ((options?.count ?? 2) + 1), 100);
	await flushBrowserTasks();
	return { ...state, harness, mutations };
}

export async function finishArticleMutation(harness: Awaited<ReturnType<typeof createBrowserHarness>>, buttonId: string) {
	harness.elements.get(buttonId)!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.disabled === false, 100);
	await waitForBrowserCondition(() => {
		const cache = harness.getCacheSizes();
		return cache.active === 0 && cache.pending === 0 && cache.membership === 0;
	}, 1000);
}

export async function setBrowserQuery(harness: Awaited<ReturnType<typeof createBrowserHarness>>, query: string) {
	harness.elements.get('article-search-input')!.value = query;
	harness.elements.get('article-query-form')!.dispatch('submit');
	await flushBrowserTasks();
}

export async function drainBrowserMembershipPages(harness: Awaited<ReturnType<typeof createBrowserHarness>>) {
	for (let attempt = 0; attempt < 160; attempt += 1) {
		await flushBrowserTasks();
		const button = harness.elements.get('load-more-button');
		assert.ok(button);
		if (button.classList.contains('hidden')) return;
		await waitForBrowserCondition(() => !button.disabled, 100);
		button.dispatch('click');
	}
	assert.fail('Browser membership pagination did not finish');
}

export async function collectBrowserWindowIds(harness: Awaited<ReturnType<typeof createBrowserHarness>>) {
	await drainBrowserMembershipPages(harness);
	await waitForTodayWindow(harness);
	for (let page = 0; page < 30 && !harness.elements.get('article-newer-button')!.disabled; page += 1) {
		harness.elements.get('article-newer-button')!.dispatch('click');
		await waitForTodayWindow(harness);
	}
	const ids = new Set<string>();
	for (let page = 0; page < 30; page += 1) {
		await drainBrowserMembershipPages(harness);
		await waitForTodayWindow(harness);
		const visible = renderedArticleIds(harness);
		assert.ok(visible.length <= 200);
		for (const id of visible) ids.add(id);
		if (harness.elements.get('article-older-button')!.disabled || harness.elements.get('article-page-controls')!.classList.contains('hidden')) return [...ids];
		harness.elements.get('article-older-button')!.dispatch('click');
		await waitForTodayWindow(harness);
	}
	assert.fail('Browser windows did not finish');
}

export class BrowserSqliteStatement {
	private values: Array<string | number | null> = [];
	constructor(private database: DatabaseSync, private sql: string) {}
	bind(...values: Array<string | number | null>) { this.values = values; return this; }
	async all<T>() { return { results: this.database.prepare(this.sql).all(...this.values) as T[] }; }
	async first<T>() { return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
	async run() { return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.values).changes) } }; }
	// D1 batch results carry both rows and change counts.
	async execute() {
		const { results } = await this.all();
		const { changes } = this.database.prepare('SELECT changes() AS changes').get() as { changes: number };
		return { results, meta: { changes: Number(changes) } };
	}
}

export function createLargeTodaySqliteLibrary(now: number, count = 2_105) {
	const database = new DatabaseSync(':memory:');
	database.exec(readFileSync(new URL('../../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	database.prepare("INSERT INTO feeds (feed_key, display_name) VALUES ('today-source', 'Today source')").run();
	const insert = database.prepare(`INSERT INTO items (id, feed_key, subject, html_content, message_id, received_at)
	 VALUES (?, 'today-source', ?, ?, ?, ?)`);
	const bounds = getLocalDayBounds(new Date(now));
	database.exec('BEGIN');
	for (let id = 1; id <= count + 2; id += 1) {
		const published = id === count + 1 ? bounds.endSeconds + 1 : id === count + 2 ? bounds.startSeconds - 1 : bounds.startSeconds + id;
		insert.run(`today-${id}`, `Story ${id}`, `<p>Body ${id}</p>`, `message-${id}`, new Date(published * 1000).toISOString());
	}
	database.exec('COMMIT');
	const db = {
		prepare: (sql: string) => new BrowserSqliteStatement(database, sql),
		async batch(statements: BrowserSqliteStatement[]) {
			database.exec('BEGIN');
			try { const results = []; for (const statement of statements) results.push(await statement.execute()); database.exec('COMMIT'); return results; }
			catch (error) { database.exec('ROLLBACK'); throw error; }
		},
	};
	return { database, env: { DB: db, BASE_URL: 'https://pigeon.example', API_PASSWORD: 'today-test-password' } as never };
}

export async function waitForTodayWindow(harness: Awaited<ReturnType<typeof createBrowserHarness>>) {
	await waitForBrowserCondition(() => {
		const cache = harness.getCacheSizes();
		return cache.active === 0 && cache.queued === 0 && cache.pending === 0 && !cache.paging && cache.membership === 0 &&
			!harness.elements.get('articles-list')?.textContent.includes('Loading');
	}, 1_000);
	assert.ok(harness.getCacheSizes().bodies <= 500);
	assert.ok(harness.getCacheSizes().metadata <= 2_000);
}

export function renderedArticleIds(harness: Awaited<ReturnType<typeof createBrowserHarness>>) {
	return harness.elements.get('articles-list')!.children.map((row) => row.children.find((child) => child.dataset.itemId)?.dataset.itemId).filter((id): id is string => Boolean(id));
}
