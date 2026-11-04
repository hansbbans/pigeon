/*
 * YouTube transcripts in the web reader: fetching through Defuddle and the
 * Worker's YouTube proxy, and the synced transcript view under the player.
 *
 * The view's logic (active segment from the player's time, auto-scroll that
 * pauses while the reader scrolls, click to seek, chapters as headings, the
 * IFrame API postMessage protocol) is adapted from Obsidian Web Clipper's
 * src/utils/reader-transcript.ts, https://github.com/obsidianmd/obsidian-clipper
 *
 * MIT License
 *
 * Copyright (c) 2024 Obsidian
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Every function here is serialized into the page with toString(), so each
 * must be self-contained: bundling may rename module-level names, so helpers
 * are passed in (see the window.PigeonTranscript wrappers at the end).
 */

export interface BrowserTranscriptSegment { start: number; duration?: number; text: string }
export interface BrowserTranscriptChapter { start: number; title: string }
export interface BrowserTranscript {
	version: 1;
	language?: string;
	segments: BrowserTranscriptSegment[];
	chapters?: BrowserTranscriptChapter[];
}

/** M:SS, or H:MM:SS from an hour. */
export function formatTranscriptTime(seconds: number): string {
	const total = Math.max(0, Math.floor(Number(seconds) || 0));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (value: number) => (value < 10 ? '0' : '') + value;
	return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

/**
 * Defuddle's transcript text (`variables.transcript`) as a stored transcript
 * document. That text is `### Chapter` headings and `**M:SS** · text` lines;
 * a chapter starts at the segment that follows it. Null when nothing parses.
 */
export function parseDefuddleTranscript(text: unknown, language?: unknown): BrowserTranscript | null {
	if (typeof text !== 'string' || !text.trim()) return null;
	const segments: BrowserTranscriptSegment[] = [];
	const chapters: BrowserTranscriptChapter[] = [];
	let pendingChapters: string[] = [];
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line) continue;
		const heading = /^#{1,6}\s+(.+)$/.exec(line);
		if (heading) { pendingChapters.push(heading[1].trim()); continue; }
		const match = /^\*\*(\d{1,3}(?::\d{1,2}){1,2})\*\*\s*·\s*(.*)$/.exec(line);
		if (!match) continue;
		const parts = match[1].split(':').map(Number);
		const start = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
		const segmentText = match[2].replace(/\s+/g, ' ').trim();
		if (!segmentText || !Number.isFinite(start)) continue;
		for (const title of pendingChapters) chapters.push({ start, title });
		pendingChapters = [];
		segments.push({ start, text: segmentText });
	}
	if (segments.length === 0) return null;
	segments.sort((a, b) => a.start - b.start);
	for (let index = 0; index < segments.length - 1; index += 1) {
		const duration = segments[index + 1].start - segments[index].start;
		if (duration > 0) segments[index].duration = duration;
	}
	const code = typeof language === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(language.trim()) ? language.trim() : '';
	return {
		version: 1,
		...(code ? { language: code } : {}),
		segments,
		...(chapters.length > 0 ? { chapters } : {}),
	};
}

/** Index of the segment playing at `time` (the last one starting at or before it), or -1. */
export function activeTranscriptIndex(starts: number[], time: number): number {
	if (!Number.isFinite(time)) return -1;
	let low = 0;
	let high = starts.length - 1;
	let found = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if (starts[middle] <= time) { found = middle; low = middle + 1; } else high = middle - 1;
	}
	return found;
}

/** The IFrame API reports time in `infoDelivery` messages; anything else is ignored. */
export function readYouTubePlayerMessage(data: unknown): { currentTime?: number; playerState?: number } | null {
	let value: any = data;
	if (typeof value === 'string') {
		if (value.length > 100_000) return null;
		try { value = JSON.parse(value); } catch { return null; }
	}
	const info = value && typeof value === 'object' ? value.info : null;
	if (!info || typeof info !== 'object') return null;
	const result: { currentTime?: number; playerState?: number } = {};
	if (typeof info.currentTime === 'number' && Number.isFinite(info.currentTime)) result.currentTime = info.currentTime;
	if (typeof info.playerState === 'number') result.playerState = info.playerState;
	return result.currentTime === undefined && result.playerState === undefined ? null : result;
}

/** A command for the embedded player, e.g. `seekTo` with `[seconds, true]`. */
export function youtubePlayerCommand(func: string, args: unknown[] = []): string {
	return JSON.stringify({ event: 'command', func, args, id: 'pigeon-transcript', channel: 'widget' });
}

/** Scroll offset that puts a segment a third of the way down the transcript box, clamped. */
export function transcriptScrollTarget(offsetTop: number, height: number, viewportHeight: number, scrollHeight: number): number | null {
	if (![offsetTop, height, viewportHeight, scrollHeight].every(Number.isFinite) || viewportHeight <= 0) return null;
	const max = Math.max(0, scrollHeight - viewportHeight);
	return Math.round(Math.min(max, Math.max(0, offsetTop - viewportHeight / 3 + height / 2)));
}

/** Auto-scroll waits this long after the reader last scrolled the transcript. */
export function shouldAutoScrollTranscript(nowMs: number, lastUserScrollMs: number, cooldownMs: number): boolean {
	return nowMs - lastUserScrollMs >= cooldownMs;
}

/**
 * A fetch for Defuddle that sends each YouTube request through the Worker
 * proxy. The browser may not set User-Agent itself, so it travels in a
 * header the proxy validates.
 */
export function createYouTubeProxyFetch(authenticatedFetch: (input: string, init: Record<string, unknown>) => Promise<Response>) {
	return function proxiedYouTubeFetch(input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }): Promise<Response> {
		const target = typeof input === 'string' ? input : input && typeof (input as { url?: unknown }).url === 'string' ? (input as { url: string }).url : String(input);
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(init?.headers || {})) {
			const key = name.toLowerCase();
			if (key === 'user-agent') headers['X-Pigeon-Upstream-User-Agent'] = String(value);
			else if (key === 'accept-language') headers['X-Pigeon-Upstream-Language'] = String(value);
			else if (key === 'content-type') headers['Content-Type'] = String(value);
		}
		return authenticatedFetch('/api/v1/browser/youtube-proxy?url=' + encodeURIComponent(target), {
			method: init?.method || 'GET', headers,
			...(init?.body === undefined ? {} : { body: init.body }),
			...(init?.signal ? { signal: init.signal } : {}),
		});
	};
}

/**
 * Runs Defuddle's YouTube extractor (parseAsync) on an empty document for the
 * watch URL, so every byte comes through `fetch`. Rejects on timeout or when
 * no transcript came back; never waits longer than `timeoutMs`. Every fetch
 * carries this run's AbortSignal: when the run ends (timeout, failure or
 * success) in-flight requests abort and later ones reject at once, so a retry
 * never overlaps a previous run's network traffic.
 */
export async function fetchYouTubeTranscript(options: {
	Defuddle: any; doc: any; videoId: string; fetch: unknown; timeoutMs?: number; signal?: AbortSignal; parse: (text: unknown, language?: unknown) => BrowserTranscript | null;
}): Promise<BrowserTranscript> {
	const { Defuddle, doc, videoId } = options;
	if (typeof Defuddle !== 'function') throw new Error('Defuddle is unavailable');
	if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('Not a YouTube video');
	const url = 'https://www.youtube.com/watch?v=' + videoId;
	const controller = new AbortController();
	const baseFetch = options.fetch as (input: unknown, init?: any) => Promise<Response>;
	const boundFetch = (input: unknown, init?: any) => {
		if (controller.signal.aborted) return Promise.reject(Object.assign(new Error('The transcript request ended'), { name: 'AbortError' }));
		const own = init?.signal;
		// Defuddle sets its own per-request timeouts; either signal aborts the request.
		const signal = own && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' ? AbortSignal.any([own, controller.signal]) : controller.signal;
		return baseFetch(input, { ...init, signal });
	};
	let timer: ReturnType<typeof setTimeout> | null = null;
	let onAbort: (() => void) | null = null;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error('The transcript request timed out')), options.timeoutMs ?? 25_000);
		// The caller's signal (a newer run, or logging out) ends this run too.
		if (options.signal) {
			onAbort = () => reject(Object.assign(new Error('The transcript request was cancelled'), { name: 'AbortError' }));
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener('abort', onAbort, { once: true });
		}
	});
	try {
		const page = doc.implementation.createHTMLDocument('');
		const result: any = await Promise.race([new Defuddle(page, { url, fetch: boundFetch, useAsync: true }).parseAsync(), timeout]);
		const transcript = options.parse(result?.variables?.transcript, result?.language);
		if (!transcript) throw new Error('This video has no transcript');
		return transcript;
	} finally {
		if (timer !== null) clearTimeout(timer);
		if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort);
		controller.abort();
	}
}

/**
 * Renders a transcript into `container` and keeps it in step with the
 * embedded player: the playing segment is highlighted and scrolled into
 * view unless the reader scrolled the transcript in the last few seconds;
 * clicking a segment or chapter seeks the player.
 */
export function createTranscriptView(options: {
	doc: any; win: any; container: any; transcript: BrowserTranscript;
	getPlayerWindow: () => any; now?: () => number; cooldownMs?: number; listenDelayMs?: number;
	helpers: {
		formatTranscriptTime: (seconds: number) => string;
		activeTranscriptIndex: (starts: number[], time: number) => number;
		readYouTubePlayerMessage: (data: unknown) => { currentTime?: number; playerState?: number } | null;
		youtubePlayerCommand: (func: string, args?: unknown[]) => string;
		transcriptScrollTarget: (offsetTop: number, height: number, viewportHeight: number, scrollHeight: number) => number | null;
		shouldAutoScrollTranscript: (nowMs: number, lastUserScrollMs: number, cooldownMs: number) => boolean;
	};
}) {
	const { doc, win, container, transcript, helpers } = options;
	const now = options.now || (() => Date.now());
	const cooldownMs = options.cooldownMs ?? 4000;
	const PLAYER_ORIGIN = 'https://www.youtube.com';
	const segments = transcript.segments;
	const starts = segments.map((segment) => segment.start);
	const chapters = (transcript.chapters || []).slice().sort((a, b) => a.start - b.start);
	const nodes: any[] = [];
	const make = (tag: string, className: string, text?: string) => {
		const element = doc.createElement(tag);
		element.classList.add(className);
		if (text !== undefined) element.textContent = text;
		return element;
	};
	const timeButton = (start: number, label: string) => {
		const button = make('button', 'transcript-time', helpers.formatTranscriptTime(start));
		button.setAttribute('type', 'button');
		button.setAttribute('aria-label', label + ' ' + helpers.formatTranscriptTime(start));
		return button;
	};
	const children: any[] = [];
	let chapterIndex = 0;
	for (const [index, segment] of segments.entries()) {
		while (chapterIndex < chapters.length && chapters[chapterIndex].start <= segment.start) {
			const chapter = chapters[chapterIndex];
			const heading = make('h4', 'transcript-chapter');
			heading.setAttribute('data-transcript-seek', String(chapter.start));
			heading.appendChild(timeButton(chapter.start, 'Play chapter from'));
			heading.appendChild(make('span', 'transcript-chapter-title', chapter.title));
			children.push(heading);
			chapterIndex += 1;
		}
		const row = make('p', 'transcript-segment');
		row.setAttribute('data-transcript-seek', String(segment.start));
		row.setAttribute('data-transcript-index', String(index));
		row.appendChild(timeButton(segment.start, 'Play from'));
		row.appendChild(make('span', 'transcript-text', segment.text));
		nodes.push(row);
		children.push(row);
	}
	container.replaceChildren(...children);
	container.scrollTop = 0;

	let activeIndex = -1;
	let lastUserScroll = -Infinity;
	let expectedScrollTop = Number.NaN;
	let answered = false;
	let listenTimer: ReturnType<typeof setTimeout> | null = null;
	let destroyed = false;

	const post = (message: string) => {
		const player = options.getPlayerWindow();
		if (!player || typeof player.postMessage !== 'function') return false;
		try { player.postMessage(message, PLAYER_ORIGIN); return true; } catch { return false; }
	};
	const scrollToActive = () => {
		const node = nodes[activeIndex];
		if (!node) return;
		const target = helpers.transcriptScrollTarget(node.offsetTop, node.offsetHeight, container.clientHeight, container.scrollHeight);
		if (target === null || Math.abs(target - (container.scrollTop || 0)) < 2) return;
		expectedScrollTop = target;
		container.scrollTop = target;
	};
	const update = (time: number) => {
		if (destroyed) return;
		const index = helpers.activeTranscriptIndex(starts, time);
		if (index === activeIndex) return;
		const previous = nodes[activeIndex];
		if (previous) { previous.classList.remove('is-active'); previous.setAttribute('aria-current', 'false'); }
		activeIndex = index;
		const next = nodes[index];
		if (!next) return;
		next.classList.add('is-active');
		next.setAttribute('aria-current', 'true');
		if (helpers.shouldAutoScrollTranscript(now(), lastUserScroll, cooldownMs)) scrollToActive();
	};
	const seek = (time: number) => {
		if (!Number.isFinite(time) || time < 0) return;
		post(helpers.youtubePlayerCommand('seekTo', [time, true]));
		// Following the click is the reader's choice; keep the row where it is.
		lastUserScroll = now();
		update(time);
	};

	const markUserScroll = () => { lastUserScroll = now(); };
	const onScroll = () => {
		// The scroll event our own scrollTop write produces is not the reader's;
		// every other scroll (wheel, keyboard, scrollbar, touch) pauses auto-scroll.
		if (Number.isFinite(expectedScrollTop) && Math.abs((container.scrollTop || 0) - expectedScrollTop) <= 2) {
			expectedScrollTop = Number.NaN;
			return;
		}
		expectedScrollTop = Number.NaN;
		markUserScroll();
	};
	const onClick = (event: any) => {
		let element = event.target;
		const isButton = element?.tagName === 'BUTTON';
		const selection = win.getSelection?.();
		// Selecting text to copy is not a seek; the time button always is.
		if (!isButton && selection && String(selection).length > 0) return;
		while (element && element !== container) {
			const value = element.getAttribute?.('data-transcript-seek');
			if (value !== null && value !== undefined) { seek(Number(value)); return; }
			element = element.parentElement;
		}
	};
	const onMessage = (event: any) => {
		const player = options.getPlayerWindow();
		if (!player || event.source !== player || event.origin !== PLAYER_ORIGIN) return;
		const info = helpers.readYouTubePlayerMessage(event.data);
		if (!info) return;
		if (!answered) {
			answered = true;
			if (listenTimer !== null) clearTimeout(listenTimer);
			listenTimer = null;
		}
		if (info.currentTime !== undefined) update(info.currentTime);
	};
	container.addEventListener('scroll', onScroll);
	container.addEventListener('wheel', markUserScroll);
	container.addEventListener('touchmove', markUserScroll);
	container.addEventListener('click', onClick);
	win.addEventListener('message', onMessage);
	// "listening" subscribes this page to the player's infoDelivery messages,
	// which then carry currentTime while the video plays. The player may still
	// be loading, so repeat it with backoff until the first answer, then stop:
	// no timer runs while the transcript is simply showing.
	let listenDelay = options.listenDelayMs ?? 250;
	let listenAttempts = 0;
	const listen = () => {
		listenTimer = null;
		if (destroyed || answered) return;
		post(JSON.stringify({ event: 'listening', id: 'pigeon-transcript', channel: 'widget' }));
		listenAttempts += 1;
		if (listenAttempts >= 10) return;
		listenTimer = setTimeout(listen, listenDelay);
		listenDelay = Math.min(listenDelay * 2, 8000);
	};
	listen();

	return {
		update,
		seek,
		activeIndex: () => activeIndex,
		destroy() {
			if (destroyed) return;
			destroyed = true;
			if (listenTimer !== null) clearTimeout(listenTimer);
			listenTimer = null;
			container.removeEventListener('scroll', onScroll);
			container.removeEventListener('wheel', markUserScroll);
			container.removeEventListener('touchmove', markUserScroll);
			container.removeEventListener('click', onClick);
			win.removeEventListener('message', onMessage);
			container.replaceChildren();
		},
	};
}

export function renderBrowserTranscriptScript(): string {
	return `
// Transcript view adapted from Obsidian Web Clipper (src/utils/reader-transcript.ts),
// MIT License, Copyright (c) 2024 Obsidian. Full notice: src/browser-transcript.ts.
function __name(target) { return target; }
${formatTranscriptTime.toString()}
${parseDefuddleTranscript.toString()}
${activeTranscriptIndex.toString()}
${readYouTubePlayerMessage.toString()}
${youtubePlayerCommand.toString()}
${transcriptScrollTarget.toString()}
${shouldAutoScrollTranscript.toString()}
${createYouTubeProxyFetch.toString()}
${fetchYouTubeTranscript.toString()}
${createTranscriptView.toString()}
window.PigeonTranscript = {
  formatTranscriptTime, parseDefuddleTranscript, activeTranscriptIndex, readYouTubePlayerMessage,
  youtubePlayerCommand, transcriptScrollTarget, shouldAutoScrollTranscript, createYouTubeProxyFetch,
  fetchYouTubeTranscript: (options) => fetchYouTubeTranscript({ ...options, parse: parseDefuddleTranscript }),
  createTranscriptView: (options) => createTranscriptView({ ...options, helpers: { formatTranscriptTime, activeTranscriptIndex,
    readYouTubePlayerMessage, youtubePlayerCommand, transcriptScrollTarget, shouldAutoScrollTranscript } }),
};
`.trim();
}
