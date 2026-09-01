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

	function __pigeonPrepareSource(root) {
		// This runs while the source is still in a detached HTMLDocument. Keep
		// Readability's useful display styles, but remove every active or
		// resource-bearing path before anything can enter the WebView document.
		const blockedTags = new Set([
			"applet", "audio", "base", "button", "canvas", "embed", "form", "frame", "frameset", "iframe", "input", "link",
			"meta", "object", "option", "portal", "script", "select", "source", "style", "svg", "template", "textarea", "track", "video",
		]);
		const removedAttributes = new Set([
			"action", "background", "data", "formaction", "ping", "poster", "srcdoc", "xlink:href",
		]);
		const elements = root instanceof Element ? [root, ...Array.from(root.querySelectorAll("*"))] : Array.from(root.querySelectorAll("*"));
		for (const element of elements) {
			const tag = element.tagName.toLowerCase();
			if (blockedTags.has(tag)) {
				element.remove();
				continue;
			}

			for (const attribute of Array.from(element.attributes)) {
				const name = attribute.name.toLowerCase();
				const value = attribute.value;
				if (
					name.startsWith("on")
					|| removedAttributes.has(name)
					|| (name === "style" && /@import|url\\s*\\(|expression\\s*\\(|javascript\\s*:|behavior\\s*:|-moz-binding/i.test(value))
				) {
					element.removeAttribute(attribute.name);
					continue;
				}
				if (name === "src" && tag !== "img") {
					element.removeAttribute("src");
				}
				if (name === "srcset" && tag !== "img") {
					element.removeAttribute("srcset");
				}
			}

			if (tag === "img") {
				const src = element.getAttribute("src");
				if (src && !element.getAttribute("data-src")) element.setAttribute("data-src", src);
				element.removeAttribute("src");
				const srcset = element.getAttribute("srcset");
				if (srcset && !element.getAttribute("data-srcset")) element.setAttribute("data-srcset", srcset);
				element.removeAttribute("srcset");
			}
		}
		return root;
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
		add(image.dataset.pigeonOriginalSrc);
		add(image.getAttribute("src"));
		for (const candidate of String(image.getAttribute("srcset") || "").split(",")) {
			add(candidate.trim().split(/\\s+/)[0]);
		}
		add(image.currentSrc);
		return urls;
	}

	function __pigeonPrepareTables(root) {
		for (const table of Array.from(root.querySelectorAll("table"))) {
			const role = String(table.getAttribute("role") || "").toLowerCase();
			const hasOwnHeader = Array.from(table.querySelectorAll("caption, th"))
				.some((element) => element.closest("table") === table);
			const isDataTable = role !== "presentation" && role !== "none"
				&& (["table", "grid", "treegrid"].includes(role) || hasOwnHeader);
			table.classList.remove("pigeon-data-table", "pigeon-layout-table");
			table.classList.add(isDataTable ? "pigeon-data-table" : "pigeon-layout-table");

			if (!isDataTable || (table.parentElement && table.parentElement.classList.contains("table-scroll"))) {
				continue;
			}
			const wrapper = document.createElement("div");
			wrapper.className = "table-scroll";
			table.replaceWith(wrapper);
			wrapper.appendChild(table);
		}
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
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: pigeon-image:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
			p, ul, ol, dl, blockquote, pre, figure { margin: 0 0 1.08em; }
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
			table { border-collapse: collapse; max-width: 100% !important; width: 100% !important; }
			.pigeon-layout-table { font: inherit; line-height: inherit; margin: 0; table-layout: auto; }
			.pigeon-layout-table > :is(thead, tbody, tfoot) > tr > :is(th, td), .pigeon-layout-table > tr > :is(th, td) { border: 0; padding: 0; }
			.table-scroll .pigeon-data-table { font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: .84em; line-height: 1.4; margin: 0; min-width: 0; table-layout: fixed; }
			.pigeon-data-table > :is(thead, tbody, tfoot) > tr > :is(th, td), .pigeon-data-table > tr > :is(th, td) { border: 1px solid #b7c0c6; overflow-wrap: anywhere; padding: .55em .7em; text-align: start; vertical-align: top; word-break: break-word; }
			.pigeon-data-table > :is(thead, tbody, tfoot) > tr > th, .pigeon-data-table > tr > th { background: #eef1f3; font-weight: 650; }
			.pigeon-image-failure { align-items: center; background: #eef1f3; border: 1px solid #b7c0c6; border-radius: .5em; color: #5e6971; display: flex; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: .8em; gap: .45em; justify-content: center; margin: 1.25em auto; min-height: 3.5em; padding: .75em; text-align: center; }
			.pigeon-image-blocked { align-items: center; background: #eef1f3; border: 1px solid #b7c0c6; border-radius: .5em; color: #39434a; cursor: pointer; display: flex; font: 600 .82em -apple-system, BlinkMacSystemFont, sans-serif; justify-content: center; margin: 1.25em auto; min-height: 5em; padding: 1em; width: 100%; }
			body[data-theme="light"] { color: #202124; }
			body[data-theme="light"] h1, body[data-theme="light"] h2, body[data-theme="light"] h3, body[data-theme="light"] h4, body[data-theme="light"] h5, body[data-theme="light"] h6 { color: #151515; }
			body[data-theme="dark"] { color: #ececec; }
			body[data-theme="dark"] h1, body[data-theme="dark"] h2, body[data-theme="dark"] h3, body[data-theme="dark"] h4, body[data-theme="dark"] h5, body[data-theme="dark"] h6 { color: #fafafa; }
			body[data-theme="dark"] a { color: #75c7ff; }
			body[data-theme="dark"] blockquote { border-inline-start-color: #71808b; color: #c3ccd2; }
			body[data-theme="dark"] pre, body[data-theme="dark"] .pigeon-data-table th, body[data-theme="dark"] .pigeon-image-failure, body[data-theme="dark"] .pigeon-image-blocked { background: #252c31; }
			body[data-theme="dark-gray"] { background: #1c1c1e; color: #f2f2f7; }
			body[data-theme="dark-gray"] h1, body[data-theme="dark-gray"] h2, body[data-theme="dark-gray"] h3, body[data-theme="dark-gray"] h4, body[data-theme="dark-gray"] h5, body[data-theme="dark-gray"] h6 { color: #ffffff; }
			body[data-theme="dark-gray"] a { color: #64d2ff; }
			body[data-theme="dark-gray"] blockquote { border-inline-start-color: #8e8e93; color: #d1d1d6; }
			body[data-theme="dark-gray"] hr { border-top-color: #636366; }
			body[data-theme="dark-gray"] pre, body[data-theme="dark-gray"] .pigeon-data-table th, body[data-theme="dark-gray"] .pigeon-image-failure, body[data-theme="dark-gray"] .pigeon-image-blocked { background: #2c2c2e; }
			body[data-theme="dark-gray"] .pigeon-data-table th, body[data-theme="dark-gray"] .pigeon-data-table td { border-color: #636366; }
			body[data-theme="dark-gray"] figcaption { color: #aeaeb2; }
			body[data-theme="dark-gray"] .pigeon-image-failure, body[data-theme="dark-gray"] .pigeon-image-blocked { border-color: #636366; color: #d1d1d6; }
			body[data-theme="sepia"] { color: #433a2c; }
			body[data-theme="sepia"] h1, body[data-theme="sepia"] h2, body[data-theme="sepia"] h3, body[data-theme="sepia"] h4, body[data-theme="sepia"] h5, body[data-theme="sepia"] h6 { color: #2f281e; }
			body[data-theme="sepia"] a { color: #735c17; }
			body[data-theme="sepia"] blockquote { border-inline-start-color: #a58b62; color: #62533d; }
			body[data-theme="sepia"] pre, body[data-theme="sepia"] .pigeon-data-table th, body[data-theme="sepia"] .pigeon-image-failure, body[data-theme="sepia"] .pigeon-image-blocked { background: #ede2c9; }
			@media (prefers-color-scheme: dark) {
				body { color: #ececec; }
				h1, h2, h3, h4, h5, h6 { color: #fafafa; }
				a { color: #75c7ff; }
				blockquote { border-inline-start-color: #71808b; color: #c3ccd2; }
				hr { border-top-color: #63717a; }
				pre, .pigeon-data-table th, .pigeon-image-failure { background: #252c31; }
				.pigeon-data-table th, .pigeon-data-table td { border-color: #63717a; }
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
				document.body.dataset.theme = payload.theme || "system";
				const template = document.createElement("template");
				template.innerHTML = payload.html || "";
				__pigeonSanitizeRoot(template.content, payload.baseURL || document.baseURI);
				content.replaceChildren(...Array.from(template.content.childNodes));
				for (const image of Array.from(content.querySelectorAll("img"))) {
					const source = image.currentSrc || image.getAttribute("src");
					if (!source) continue;
					if (payload.remoteImagePolicy === "blocked") {
						const placeholder = document.createElement("button");
						placeholder.type = "button";
						placeholder.className = "pigeon-image-blocked";
						placeholder.textContent = "Load this remote image";
						placeholder.setAttribute("aria-label", "Load this remote image. The publisher may see your network address.");
						placeholder.addEventListener("click", function(event) {
							event.preventDefault();
							event.stopPropagation();
							placeholder.replaceWith(image);
							__pigeonMeasure();
						});
						image.replaceWith(placeholder);
					} else if (payload.remoteImagePolicy === "privacy-proxied") {
						image.dataset.pigeonOriginalSrc = source;
						image.removeAttribute("srcset");
						image.src = "pigeon-image://proxy?url=" + encodeURIComponent(source);
					}
				}
				__pigeonPrepareTables(content);
				__pigeonMeasure();
			};
			document.addEventListener("click", function(event) {
				const target = event.target;
				if (!(target instanceof Element) || !content.contains(target)) return;
				// Ask Before Loading placeholders replace the <img>, including
				// inside newsletter <a> wrappers. That tap must load the image,
				// not open the surrounding link.
				if (target.closest(".pigeon-image-blocked")) {
					return;
				}
				const image = target.closest("img");
				if (image) {
					event.preventDefault();
					event.stopPropagation();
					window.webkit.messageHandlers.pigeonEvent.postMessage({
						kind: "image",
						imageURL: image.dataset.pigeonOriginalSrc || image.currentSrc || image.src,
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
				const imageURL = __pigeonSafeURL(image.dataset.pigeonOriginalSrc, document.baseURI)
					|| __pigeonSafeURL(image.currentSrc, document.baseURI)
					|| __pigeonSafeURL(image.src, document.baseURI)
					|| null;
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
