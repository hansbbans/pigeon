const MAX_PREVIEW_LENGTH = 280;
const HTML_BLOCK_PATTERN =
	/<!doctype|<!--|<\?xml|<(html|head|body|style|script|article|section|div|p|table|ul|ol|li|img|br|hr|a)\b/i;
const HTML_PAIR_PATTERN = /<([a-z][a-z0-9:-]*)\b[^>]*>[\s\S]*<\/\1>/i;

function normalizeWhitespace(value: string): string {
	return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export function decodeHtmlTextEntities(value: string): string {
	const named: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
	return value.replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (entity: string, body: string) => {
		const normalized = body.toLowerCase();
		if (!normalized.startsWith('#')) return named[normalized];
		const hexadecimal = normalized.startsWith('#x');
		const codePoint = Number.parseInt(normalized.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
		if (
			!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff ||
			(codePoint >= 0xd800 && codePoint <= 0xdfff)
		) return entity;
		return String.fromCodePoint(codePoint);
	});
}

function stripHtmlToText(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
		.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<br\b[^>]*\/?>/gi, ' ')
		.replace(/<\/(p|div|li|tr|td|th|section|article|h[1-6])>/gi, ' ')
		.replace(/<[^>]+>/g, ' ');
}

function looksLikeHtml(value: string): boolean {
	return HTML_BLOCK_PATTERN.test(value) || HTML_PAIR_PATTERN.test(value);
}

function truncatePreview(value: string): string {
	if (value.length <= MAX_PREVIEW_LENGTH) {
		return value;
	}

	const truncated = value.slice(0, MAX_PREVIEW_LENGTH);
	const lastWordBoundary = truncated.lastIndexOf(' ');
	const safeTruncation = lastWordBoundary > MAX_PREVIEW_LENGTH * 0.6
		? truncated.slice(0, lastWordBoundary)
		: truncated;

	return `${safeTruncation.trimEnd()}...`;
}

export function createPreviewText(input: {
	textContent?: string | null;
	htmlContent?: string | null;
}): string {
	const preferredText = normalizeWhitespace(input.textContent ?? '');
	if (preferredText) {
		return truncatePreview(preferredText);
	}

	const rawHtml = input.htmlContent ?? '';
	const normalizedText = looksLikeHtml(rawHtml)
		? normalizeWhitespace(decodeHtmlTextEntities(stripHtmlToText(rawHtml)))
		: normalizeWhitespace(decodeHtmlTextEntities(rawHtml));

	return truncatePreview(normalizedText);
}
