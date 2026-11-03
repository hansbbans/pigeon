/**
 * Cheap word counts for reading-length estimates.
 *
 * The Worker runs on the Free plan (10 ms CPU), so this is a single linear
 * scan with no regex replace over the body, and it reads at most
 * WORD_COUNT_SOURCE_LIMIT characters. Tags act as word boundaries; head,
 * style, script and template content and comments are skipped.
 */

export const WORD_COUNT_SOURCE_LIMIT = 300_000;

const RAW_TEXT_CLOSERS: Record<string, RegExp> = {
	head: /<\/head\s*>/gi,
	script: /<\/script\s*>/gi,
	style: /<\/style\s*>/gi,
	template: /<\/template\s*>/gi,
};

const NON_BREAKING_SPACE_ENTITIES = ['&nbsp;', '&#160;', '&#xa0;'];

function isWhitespace(code: number): boolean {
	return code <= 32 || code === 160 || (code >= 0x2000 && code <= 0x200b) || code === 0x3000;
}

function isAsciiLetter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function tagNameAt(source: string, start: number): string {
	let end = start;
	while (end < source.length && end - start < 10 && isAsciiLetter(source.charCodeAt(end))) end += 1;
	return source.slice(start, end).toLowerCase();
}

export function countWordsInHtml(html: string): number {
	const source = html.length > WORD_COUNT_SOURCE_LIMIT ? html.slice(0, WORD_COUNT_SOURCE_LIMIT) : html;
	const length = source.length;
	let count = 0;
	let inWord = false;
	let index = 0;
	while (index < length) {
		const code = source.charCodeAt(index);
		if (code === 60 /* < */) {
			inWord = false;
			if (source.startsWith('<!--', index)) {
				const end = source.indexOf('-->', index + 4);
				index = end < 0 ? length : end + 3;
				continue;
			}
			const close = source.indexOf('>', index + 1);
			if (close < 0) break;
			const closer = RAW_TEXT_CLOSERS[tagNameAt(source, index + 1)];
			if (closer) {
				closer.lastIndex = close + 1;
				const match = closer.exec(source);
				index = match ? match.index + match[0].length : length;
				continue;
			}
			index = close + 1;
			continue;
		}
		if (code === 38 /* & */) {
			const entity = source.slice(index, index + 6).toLowerCase();
			const spaceEntity = NON_BREAKING_SPACE_ENTITIES.find((candidate) => entity.startsWith(candidate));
			if (spaceEntity) {
				inWord = false;
				index += spaceEntity.length;
				continue;
			}
		}
		if (isWhitespace(code)) {
			inWord = false;
		} else if (!inWord) {
			inWord = true;
			count += 1;
		}
		index += 1;
	}
	return count;
}

export function countWordsInText(text: string): number {
	const length = Math.min(text.length, WORD_COUNT_SOURCE_LIMIT);
	let count = 0;
	let inWord = false;
	for (let index = 0; index < length; index += 1) {
		if (isWhitespace(text.charCodeAt(index))) {
			inWord = false;
		} else if (!inWord) {
			inWord = true;
			count += 1;
		}
	}
	return count;
}

/** Counts the rendered body: HTML when present, otherwise the plain text. */
export function countItemWords(html: string | null | undefined, text: string | null | undefined): number {
	if (html) return countWordsInHtml(html);
	if (text) return countWordsInText(text);
	return 0;
}
