import Foundation

enum StructuredHTMLJavaScript {
	static let sanitizationFunctions = """
	function __pigeonSafeURL(value, baseURL) {
		if (!value || /^\\s*(?:data|cid|javascript|vbscript|file):/i.test(value)) return null;
		try {
			const url = new URL(value.trim(), baseURL || document.baseURI);
			if (url.protocol !== "http:" && url.protocol !== "https:") return null;
			if (!url.hostname) return null;
			return url.href;
		} catch (_) {
			return null;
		}
	}

	function __pigeonSafeSrcset(value, baseURL) {
		return String(value || "").split(",").map((candidate) => {
			const parts = candidate.trim().split(/\\s+/);
			const url = __pigeonSafeURL(parts.shift(), baseURL);
			if (!url) return null;
			const descriptors = parts.filter((descriptor) => /^\\d+(?:\\.\\d+)?[wx]$/.test(descriptor));
			return url + (descriptors.length ? " " + descriptors.join(" ") : "");
		}).filter(Boolean).join(", ");
	}

	function __pigeonSanitizeRoot(root, baseURL) {
		const allowedTags = new Set([
			"a", "article", "aside", "blockquote", "br", "caption", "code", "col", "colgroup", "dd", "del",
			"div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "head",
			"hr", "html", "i", "img", "li", "main", "ol", "p", "pre", "q", "section", "small", "span", "strong",
			"sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "title", "tr", "u", "ul", "body",
		]);
		const blockedTags = new Set([
			"audio", "base", "button", "canvas", "embed", "form", "frame", "frameset", "iframe", "input", "link",
			"math", "meta", "noscript", "object", "option", "script", "select", "source", "style", "template",
			"svg", "textarea", "track", "video",
		]);
		const allowedAttributes = new Set([
			"alt", "aria-label", "class", "cite", "colspan", "data-lazy-src", "data-lazy-srcset", "data-original",
			"data-src", "data-srcset", "datetime", "decoding", "dir", "height", "href", "id", "lang", "loading",
			"role", "rowspan", "scope", "src", "srcset", "title", "width",
		]);

		const elements = root instanceof Element ? [root, ...Array.from(root.querySelectorAll("*"))] : Array.from(root.querySelectorAll("*"));
		for (const element of elements) {
			const tag = element.tagName.toLowerCase();
			if (blockedTags.has(tag)) {
				element.remove();
				continue;
			}
			if (!allowedTags.has(tag)) {
				element.replaceWith(...Array.from(element.childNodes));
				continue;
			}

			for (const attribute of Array.from(element.attributes)) {
				const name = attribute.name.toLowerCase();
				const value = attribute.value;
				if (name.startsWith("on") || name === "style" || name === "srcdoc" || !allowedAttributes.has(name)) {
					element.removeAttribute(attribute.name);
					continue;
				}
				if (["href", "src", "cite", "data-src", "data-original", "data-lazy-src"].includes(name)) {
					const safeURL = __pigeonSafeURL(value, baseURL);
					if (safeURL) element.setAttribute(attribute.name, safeURL); else element.removeAttribute(attribute.name);
				} else if (["srcset", "data-srcset", "data-lazy-srcset"].includes(name)) {
					const safeSrcset = __pigeonSafeSrcset(value, baseURL);
					if (safeSrcset) element.setAttribute(attribute.name, safeSrcset); else element.removeAttribute(attribute.name);
				}
			}

			if (tag === "img") {
				const source = ["src", "data-src", "data-original", "data-lazy-src"]
					.map((name) => element.getAttribute(name))
					.find(Boolean);
				const srcset = ["srcset", "data-srcset", "data-lazy-srcset"]
					.map((name) => element.getAttribute(name))
					.find(Boolean);
				if (!element.getAttribute("src") && source) element.setAttribute("src", source);
				if (!element.getAttribute("srcset") && srcset) element.setAttribute("srcset", srcset);
				for (const name of ["data-src", "data-original", "data-lazy-src", "data-srcset", "data-lazy-srcset"]) {
					element.removeAttribute(name);
				}
				if (!element.getAttribute("src") && !element.getAttribute("srcset")) element.remove();
			}
		}
		return root;
	}

	function __pigeonImageSourceURLs(image) {
		const urls = [];
		const add = (value) => {
			const safeURL = __pigeonSafeURL(value, document.baseURI);
			if (safeURL && !urls.includes(safeURL)) urls.push(safeURL);
		};
		add(image.getAttribute("src"));
		for (const candidate of String(image.getAttribute("srcset") || "").split(",")) {
			add(candidate.trim().split(/\\s+/)[0]);
		}
		add(image.currentSrc);
		return urls;
	}

	function __pigeonMeasure() {
		window.webkit.messageHandlers.pigeonEvent.postMessage({ kind: "height", value: Math.ceil(document.body.scrollHeight) });
	}
	"""

	static let renderingShell = """
	<!doctype html>
	<html>
	<head>
		<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
		<style>
			:root { color-scheme: light dark; }
			* { box-sizing: border-box; }
			html, body { margin: 0; padding: 0; max-width: 100%; overflow-x: hidden; width: 100%; }
			body {
				background: transparent;
				color: #202124;
				font-family: Bookerly, "Iowan Old Style", Georgia, serif;
				font-size: calc(18px * var(--pigeon-text-scale));
				line-height: var(--pigeon-line-height);
				word-wrap: break-word;
				overflow-wrap: anywhere;
			}
			#pigeon-content, #pigeon-content * { max-width: 100%; }
			#pigeon-content { width: 100%; }
			#pigeon-content > :first-child { margin-top: 0; }
			#pigeon-content > :last-child { margin-bottom: 0; }
			h1, h2, h3, h4, h5, h6 { color: #151515; font-family: Bookerly, "Iowan Old Style", Georgia, serif; line-height: 1.16; margin: 1.45em 0 .48em; overflow-wrap: anywhere; }
			h1 { font-size: 1.72em; }
			h2 { font-size: 1.45em; }
			h3 { font-size: 1.24em; }
			h4, h5, h6 { font-size: 1.08em; }
			p, ul, ol, dl, blockquote, pre, figure, table { margin: 0 0 1.08em; }
			p { text-wrap: pretty; }
			ul, ol { padding-left: 1.45em; }
			li + li { margin-top: .35em; }
			strong { font-family: Bookerly-Bold, Bookerly, Georgia, serif; }
			em, i { font-family: Bookerly-Italic, Bookerly, Georgia, serif; }
			a { color: #075f9a; text-decoration-thickness: .07em; text-underline-offset: .16em; }
			blockquote { border-inline-start: .22em solid #9aa6af; color: #4c5660; padding: .15em 0 .15em 1em; }
			hr { border: 0; border-top: 1px solid #aeb7bd; margin: 1.7em 0; }
			pre { background: #eef1f3; border-radius: .45em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82em; line-height: 1.5; overflow-x: auto; padding: 1em; white-space: pre-wrap; }
			code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; }
			pre code { font-size: 1em; }
			figure { margin-inline: 0; }
			img { display: block; height: auto !important; margin: 1.25em auto; max-width: 100% !important; object-fit: contain; width: auto; }
			figcaption { color: #66727b; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: .82em; line-height: 1.4; margin: -.7em auto 1.3em; max-width: 44em; text-align: center; }
			.table-scroll { margin: 0 0 1.08em; max-width: 100%; overflow-x: auto; width: 100%; }
			.table-scroll table { margin: 0; max-width: 100% !important; min-width: 0; table-layout: fixed; width: 100% !important; }
			table { border-collapse: collapse; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: .84em; line-height: 1.4; max-width: 100% !important; table-layout: fixed; width: 100% !important; }
			th, td { border: 1px solid #b7c0c6; overflow-wrap: anywhere; padding: .55em .7em; text-align: start; vertical-align: top; word-break: break-word; }
			th { background: #eef1f3; font-weight: 650; }
			.pigeon-image-failure { align-items: center; background: #eef1f3; border: 1px solid #b7c0c6; border-radius: .5em; color: #5e6971; display: flex; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: .8em; gap: .45em; justify-content: center; margin: 1.25em auto; min-height: 3.5em; padding: .75em; text-align: center; }
			@media (prefers-color-scheme: dark) {
				body { color: #ececec; }
				h1, h2, h3, h4, h5, h6 { color: #fafafa; }
				a { color: #75c7ff; }
				blockquote { border-inline-start-color: #71808b; color: #c3ccd2; }
				hr { border-top-color: #63717a; }
				pre, th, .pigeon-image-failure { background: #252c31; }
				th, td { border-color: #63717a; }
				figcaption { color: #b7c1c8; }
			}
		</style>
	</head>
	<body>
		<main id="pigeon-content" aria-label="Article content"></main>
		<script>
			\(StructuredHTMLJavaScript.sanitizationFunctions)
			const content = document.getElementById("pigeon-content");
			window.__pigeonRender = function(payload) {
				document.documentElement.style.setProperty("--pigeon-text-scale", String(payload.textScale || 1));
				document.documentElement.style.setProperty("--pigeon-line-height", String(payload.lineHeight || 1.55));
				const template = document.createElement("template");
				template.innerHTML = payload.html || "";
				__pigeonSanitizeRoot(template.content, payload.baseURL || document.baseURI);
				content.replaceChildren(...Array.from(template.content.childNodes));
				for (const table of Array.from(content.querySelectorAll("table"))) {
					if (table.parentElement && table.parentElement.classList.contains("table-scroll")) continue;
					const wrapper = document.createElement("div");
					wrapper.className = "table-scroll";
					table.replaceWith(wrapper);
					wrapper.appendChild(table);
				}
				__pigeonMeasure();
			};
			document.addEventListener("click", function(event) {
				const target = event.target;
				if (!(target instanceof Element) || !content.contains(target)) return;
				const image = target.closest("img");
				if (image) {
					event.preventDefault();
					event.stopPropagation();
					window.webkit.messageHandlers.pigeonEvent.postMessage({
						kind: "image",
						imageURL: image.currentSrc || image.src,
						linkURL: image.closest("a")?.href || null,
					});
					return;
				}
				const link = target.closest("a");
				if (link && link.href) {
					event.preventDefault();
					event.stopPropagation();
					window.webkit.messageHandlers.pigeonEvent.postMessage({ kind: "link", url: link.href });
				}
			}, true);
			document.addEventListener("error", function(event) {
				const image = event.target;
				if (!(image instanceof HTMLImageElement) || !content.contains(image)) return;
				const imageURL = image.currentSrc || image.src || null;
				const placeholder = document.createElement("span");
				placeholder.className = "pigeon-image-failure";
				placeholder.setAttribute("role", "img");
				placeholder.setAttribute("aria-label", "Image unavailable");
				placeholder.textContent = "Image unavailable";
				image.replaceWith(placeholder);
				window.webkit.messageHandlers.pigeonEvent.postMessage({
					kind: "image-error",
					imageURL,
					sourceURLs: __pigeonImageSourceURLs(image),
				});
				__pigeonMeasure();
			}, true);
			new ResizeObserver(__pigeonMeasure).observe(document.body);
		</script>
	</body>
	</html>
	"""
}
