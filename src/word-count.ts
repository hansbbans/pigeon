/**
 * Word counts for reading-length estimates.
 *
 * Clients estimate a feed item's length from the body they already hold; the
 * server stores word_count only when it knows better than the body (a reader
 * mode extraction of a snippet-only item, or a saved page).
 */

export const WORD_COUNT_SOURCE_LIMIT = 300_000;

/**
 * Counts words in rendered HTML with one linear scan over at most 300 000
 * characters. Tags act as word boundaries; head, style, script and template
 * content and comments are skipped, unless their closer is missing, in which
 * case only the opening tag is skipped. Self-contained: the browser client
 * emits it via toString().
 */
export function countWordsInHtml(html: string): number {
	const sourceLimit = 300_000;
	const source = html.length > sourceLimit ? html.slice(0, sourceLimit) : html;
	const length = source.length;
	const rawTextElements = ['head', 'script', 'style', 'template'];
	const spaceEntities = ['&nbsp;', '&#160;', '&#xa0;'];
	let count = 0;
	let inWord = false;
	let index = 0;
	while (index < length) {
		const code = source.charCodeAt(index);
		// Like HTML, "<" opens a tag only before a letter, "/", "!" or "?".
		const next = code === 60 /* < */ && index + 1 < length ? source.charCodeAt(index + 1) | 32 : 0;
		if ((next >= 97 && next <= 122) || next === 47 || next === 33 || next === 63) {
			const close = source.indexOf('>', index + 1);
			if (close >= 0) {
				inWord = false;
				if (source.startsWith('<!--', index)) {
					const end = source.indexOf('-->', index + 4);
					index = end < 0 ? close + 1 : end + 3;
					continue;
				}
				let nameEnd = index + 1;
				while (nameEnd < length && nameEnd - index <= 10) {
					const letter = source.charCodeAt(nameEnd) | 32;
					if (letter < 97 || letter > 122) break;
					nameEnd += 1;
				}
				const name = source.slice(index + 1, nameEnd).toLowerCase();
				if (rawTextElements.includes(name) && source.charCodeAt(close - 1) !== 47 /* / */) {
					const closer = new RegExp(`</${name}\\s*>`, 'gi');
					closer.lastIndex = close + 1;
					const match = closer.exec(source);
					index = match ? match.index + match[0].length : close + 1;
					continue;
				}
				index = close + 1;
				continue;
			}
		}
		if (code === 38 /* & */) {
			const entity = source.slice(index, index + 6).toLowerCase();
			const spaceEntity = spaceEntities.find((candidate) => entity.startsWith(candidate));
			if (spaceEntity) {
				inWord = false;
				index += spaceEntity.length;
				continue;
			}
		}
		const isSpace = code <= 32 || code === 160 || (code >= 0x2000 && code <= 0x200b) || code === 0x3000;
		if (isSpace) {
			inWord = false;
		} else if (!inWord) {
			inWord = true;
			count += 1;
		}
		index += 1;
	}
	return count;
}
