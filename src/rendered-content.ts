const HTML_PATTERN = /<!doctype|<\?xml|<(html|head|body|style|script|article|section|div|p|table|ul|ol|li|img|br|hr|a)\b/i;
const EMAIL_CONTENT_CLASS_HINTS = [
	'email-content',
	'mail-message-content',
	'article-content',
	'main-content',
	'newsletter-content',
];
const EMAIL_FOOTER_CLASS_HINTS = ['email-body-footer', 'email-footer'];
const EMPTY_BLOCK_PATTERN =
	/<(p|div)\b[^>]*>\s*(?:&nbsp;|&#8203;|&#x200b;|&#xfeff;|\u00a0|\u200b|\ufeff|\s)*<\/\1>/gi;

function looksLikeHtml(value: string): boolean {
	return HTML_PATTERN.test(value);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderPlainText(text: string): string {
	if (!text.trim()) {
		return '';
	}

	const paragraphs = text
		.replace(/\r\n/g, '\n')
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean)
		.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`);

	return `<div data-pigeon-rendered="plain-text" style="text-align:left">${paragraphs.join('')}</div>`;
}

function stripDocumentShell(html: string): string {
	const withoutDoctype = html
		.replace(/<!doctype[^>]*>/gi, '')
		.replace(/<\?xml[^>]*>/gi, '')
		.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
	const bodyMatch = withoutDoctype.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
	return bodyMatch ? bodyMatch[1] : withoutDoctype;
}

function stripComments(html: string): string {
	return html.replace(/<!--[\s\S]*?-->/g, '');
}

function stripNonContentBlocks(html: string): string {
	return html
		.replace(/<(style|script|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
		.replace(/<meta\b[^>]*>/gi, '')
		.replace(/<link\b[^>]*>/gi, '');
}

function stripTrackingPixels(html: string): string {
	return html
		.replace(/<img\b[^>]*https?:\/\/[^"'>\s]*open\.convertkit-mail\.com[^>]*>/gi, '')
		.replace(/<img\b[^>]*(?:width|height)\s*=\s*["']?1["']?[^>]*>/gi, '');
}

function normalizeWhitespaceAroundHtml(html: string): string {
	return html
		.replace(/\n{3,}/g, '\n\n')
		.replace(EMPTY_BLOCK_PATTERN, '')
		.trim();
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSelfClosingTag(tag: string): boolean {
	return /\/>$/.test(tag) || /^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i.test(tag);
}

function findMatchingCloseTag(
	html: string,
	openTagStart: number,
	tagName: string,
): { closeStart: number; closeEnd: number } | null {
	const tagPattern = /<\/?([a-z][a-z0-9:-]*)\b[^>]*>/gi;
	tagPattern.lastIndex = openTagStart;

	let depth = 0;
	let foundOpeningTag = false;
	let match: RegExpExecArray | null;

	while ((match = tagPattern.exec(html)) !== null) {
		const [tag, matchedName] = match;
		if (matchedName.toLowerCase() !== tagName) {
			continue;
		}

		const isClosing = tag.startsWith('</');
		if (!foundOpeningTag) {
			if (match.index !== openTagStart || isClosing) {
				return null;
			}
			foundOpeningTag = true;
			if (!isSelfClosingTag(tag)) {
				depth = 1;
			}
			continue;
		}

		if (isClosing) {
			depth -= 1;
			if (depth === 0) {
				return { closeStart: match.index, closeEnd: match.index + tag.length };
			}
			continue;
		}

		if (!isSelfClosingTag(tag)) {
			depth += 1;
		}
	}

	return null;
}

function extractElementInnerHtmlByPattern(html: string, pattern: RegExp): string | null {
	const match = pattern.exec(html);
	if (!match) {
		return null;
	}

	const tagName = match[1].toLowerCase();
	const openTagStart = match.index;
	const openTagEnd = openTagStart + match[0].length;
	const closeTag = findMatchingCloseTag(html, openTagStart, tagName);
	if (!closeTag) {
		return null;
	}

	return html.slice(openTagEnd, closeTag.closeStart);
}

function removeElementByPattern(html: string, pattern: RegExp): string {
	let result = html;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(result)) !== null) {
		const tagName = match[1].toLowerCase();
		const openTagStart = match.index;
		const closeTag = findMatchingCloseTag(result, openTagStart, tagName);
		if (!closeTag) {
			break;
		}

		result = `${result.slice(0, openTagStart)}${result.slice(closeTag.closeEnd)}`;
		pattern.lastIndex = 0;
	}

	return result;
}

function extractElementInnerHtmlByClass(html: string, className: string): string | null {
	const pattern = new RegExp(
		`<([a-z][a-z0-9:-]*)\\b[^>]*\\bclass=(["'])[^"'<>]*\\b${escapeRegex(className)}\\b[^"'<>]*\\2[^>]*>`,
		'i',
	);
	return extractElementInnerHtmlByPattern(html, pattern);
}

function removeElementsByClass(html: string, classNames: string[]): string {
	return classNames.reduce((result, className) => {
		const pattern = new RegExp(
			`<([a-z][a-z0-9:-]*)\\b[^>]*\\bclass=(["'])[^"'<>]*\\b${escapeRegex(className)}\\b[^"'<>]*\\2[^>]*>`,
			'i',
		);
		return removeElementByPattern(result, pattern);
	}, html);
}

function removeElementById(html: string, id: string): string {
	const pattern = new RegExp(
		`<([a-z][a-z0-9:-]*)\\b[^>]*\\bid=(["'])${escapeRegex(id)}\\2[^>]*>`,
		'i',
	);
	return removeElementByPattern(html, pattern);
}

function getSingleRootElement(html: string): { tagName: string; attributes: string; innerHtml: string } | null {
	const trimmed = html.trim();
	const openTagMatch = trimmed.match(/^<([a-z][a-z0-9:-]*)(\s[^>]*)?>/i);
	if (!openTagMatch) {
		return null;
	}

	const tagName = openTagMatch[1].toLowerCase();
	const attributes = openTagMatch[2] ?? '';
	const closeTag = findMatchingCloseTag(trimmed, 0, tagName);
	if (!closeTag) {
		return null;
	}

	if (trimmed.slice(closeTag.closeEnd).trim()) {
		return null;
	}

	return {
		tagName,
		attributes,
		innerHtml: trimmed.slice(openTagMatch[0].length, closeTag.closeStart),
	};
}

function isLikelyLayoutWrapper(tagName: string, attributes: string): boolean {
	if (['tbody', 'tr', 'td', 'center'].includes(tagName)) {
		return true;
	}

	if (!['div', 'table'].includes(tagName)) {
		return false;
	}

	const lowerAttributes = attributes.toLowerCase();
	return (
		lowerAttributes.includes('role="presentation"') ||
		lowerAttributes.includes("role='presentation'") ||
		lowerAttributes.includes('table-layout:fixed') ||
		lowerAttributes.includes('border-collapse') ||
		lowerAttributes.includes('margin:0 auto') ||
		lowerAttributes.includes('max-width') ||
		lowerAttributes.includes('width:100%') ||
		lowerAttributes.includes('background-color') ||
		/\bclass=(["'])[^"'<>]*(email|container|wrapper|thin)[^"'<>]*\1/.test(lowerAttributes)
	);
}

function unwrapLayoutWrappers(html: string): string {
	let candidate = html.trim();

	for (let index = 0; index < 6; index += 1) {
		const root = getSingleRootElement(candidate);
		if (!root || !isLikelyLayoutWrapper(root.tagName, root.attributes)) {
			break;
		}
		candidate = root.innerHtml.trim();
	}

	return candidate;
}

function extractPrimaryEmailContent(html: string): string | null {
	for (const className of EMAIL_CONTENT_CLASS_HINTS) {
		const extracted = extractElementInnerHtmlByClass(html, className);
		if (
			extracted &&
			extracted.replace(/<[^>]+>/g, '').trim().length >= 20 &&
			/<(p|ul|ol|h[1-6]|img|table|blockquote)\b/i.test(extracted)
		) {
			return extracted;
		}
	}

	return null;
}

function shouldNormalizeEmailHtml(html: string): boolean {
	if (/<body\b/i.test(html) || /<!doctype/i.test(html)) {
		return true;
	}

	if (/<(style|script|meta|link)\b/i.test(html)) {
		return true;
	}

	return EMAIL_CONTENT_CLASS_HINTS.some((className) =>
		new RegExp(`\\b${escapeRegex(className)}\\b`, 'i').test(html),
	);
}

export function createRenderedContent(input: {
	htmlContent?: string | null;
	textContent?: string | null;
}): string {
	const rawHtml = input.htmlContent ?? '';
	if (!rawHtml.trim()) {
		return renderPlainText(input.textContent ?? '');
	}

	if (!looksLikeHtml(rawHtml)) {
		return renderPlainText(rawHtml);
	}

	if (!shouldNormalizeEmailHtml(rawHtml)) {
		return rawHtml;
	}

	let candidate = stripDocumentShell(rawHtml);
	candidate = stripComments(candidate);
	candidate = stripNonContentBlocks(candidate);
	candidate = removeElementById(candidate, 'preview-text');
	candidate = removeElementsByClass(candidate, EMAIL_FOOTER_CLASS_HINTS);
	candidate = stripTrackingPixels(candidate);

	const primaryContent = extractPrimaryEmailContent(candidate);
	if (primaryContent) {
		candidate = primaryContent;
	}

	candidate = unwrapLayoutWrappers(candidate);
	candidate = stripComments(candidate);
	candidate = stripTrackingPixels(candidate);
	candidate = normalizeWhitespaceAroundHtml(candidate);

	if (!candidate) {
		return rawHtml;
	}

	return `<div data-pigeon-rendered="email-fragment" style="text-align:left">${candidate}</div>`;
}
