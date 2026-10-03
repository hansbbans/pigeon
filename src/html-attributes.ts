const CONTENT_TAG_PATTERN = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][A-Za-z0-9:-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
const CONTENT_ATTRIBUTE_PATTERN = /([^\t\n\f\r =/>]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*("[^"]*"|'[^']*'|[^\t\n\f\r "'=<>`]+))?/g;
const SVG_HTML_INTEGRATION_TAGS = new Set(['foreignobject', 'desc', 'title']);
const MATH_HTML_INTEGRATION_TAGS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

/** Rewrite explicit attribute values while preserving text and other attributes. */
export function rewriteHtmlAttributes(
	html: string,
	transform: (name: string, value: string, quoted: boolean) => string | undefined,
): string {
	if (!html.includes('=')) return html;
	let rawTextTag: string | undefined;
	const foreignScopes: Array<{ name: string; namespace: 'svg' | 'math' | undefined; sourceNamespace: 'svg' | 'math' | undefined }> = [];
	return html.replace(CONTENT_TAG_PATTERN, (tag) => {
		if (tag.startsWith('<!--')) return tag;
		const nameMatch = tag.match(/^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/)!;
		const closing = nameMatch[1] === '/';
		const name = nameMatch[2].toLowerCase();
		if (rawTextTag) {
			if (closing && name === rawTextTag && rawTextTag !== 'plaintext') rawTextTag = undefined;
			return tag;
		}
		const selfClosing = tag.endsWith('/>');
		if (closing) {
			if (name === 'svg' || name === 'math' || foreignScopes.at(-1)?.name === name) {
				while (foreignScopes.length && foreignScopes.pop()!.name !== name) { /* Exit enclosing foreign scopes. */ }
			}
			return tag;
		}
		const inheritedScope = foreignScopes.at(-1);
		let namespace = inheritedScope?.namespace;
		// MathML's two glyph elements stay foreign inside a text integration point.
		const mathGlyph = inheritedScope?.sourceNamespace === 'math' && MATH_HTML_INTEGRATION_TAGS.has(inheritedScope.name) && /^(?:mglyph|malignmark)$/.test(name);
		if (mathGlyph) namespace = 'math';
		const foreignRoot = name === 'svg' || name === 'math';
		let htmlIntegration = namespace === 'svg' && SVG_HTML_INTEGRATION_TAGS.has(name);
		if (namespace === 'math') {
			htmlIntegration = MATH_HTML_INTEGRATION_TAGS.has(name);
			if (name === 'annotation-xml') {
				for (const attribute of tag.slice(nameMatch[0].length, -1).matchAll(CONTENT_ATTRIBUTE_PATTERN)) {
					if (attribute[1].toLowerCase() !== 'encoding' || attribute[2] === undefined) continue;
					const raw = attribute[2];
					const encoding = (/^["']/.test(raw) ? raw.slice(1, -1) : raw).toLowerCase();
					htmlIntegration = encoding === 'text/html' || encoding === 'application/xhtml+xml';
					break;
				}
			}
		}
		if (!selfClosing && (foreignRoot || htmlIntegration || mathGlyph)) {
			foreignScopes.push({ name, namespace: foreignRoot ? name : htmlIntegration ? undefined : namespace, sourceNamespace: foreignRoot ? name : namespace });
		}
		// A slash closes foreign elements; HTML script/style remain raw text.
		const rawTextElement = RAW_TEXT_TAGS.has(name) && (!namespace || name === 'script' || name === 'style');
		if (rawTextElement && !(namespace && selfClosing)) rawTextTag = name;
		const prefix = nameMatch[0];
		const attributes = tag.slice(prefix.length, -1).replace(CONTENT_ATTRIBUTE_PATTERN, (attribute, attributeName: string, rawValue?: string) => {
			if (rawValue === undefined) return attribute;
			const quoted = rawValue.startsWith('"') || rawValue.startsWith("'");
			const quote = quoted ? rawValue[0] : '"';
			const value = quoted ? rawValue.slice(1, -1) : rawValue;
			const replacement = transform(attributeName, value, quoted);
			return replacement === undefined ? attribute : `${attributeName}=${quote}${replacement}${quote}`;
		});
		return `${prefix}${attributes}>`;
	});
}
