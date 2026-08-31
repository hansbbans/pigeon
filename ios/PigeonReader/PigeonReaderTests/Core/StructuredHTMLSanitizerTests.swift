import Foundation
import Testing
import WebKit
@testable import PigeonReader

struct StructuredHTMLSanitizerTests {
	@Test
	func preservesStructuredReadingMarkupAndResolvesRelativeURLs() throws {
		let baseURL = try #require(URL(string: "https://example.com/newsletter/issue"))
		let html = """
		<h1>Article title</h1><h2>Heading</h2><p>A <strong>bold</strong> and <em>quiet</em> paragraph with <a href="/story">a link</a>.</p>
		<ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol><hr>
		<blockquote>Read slowly.</blockquote><pre><code>let value = 1</code></pre>
		<figure><img src="/images/small.jpg" srcset="/images/small.jpg 1x, https://cdn.example/large.jpg 2x" width="24" height="24" alt="Small image"><figcaption>Caption</figcaption></figure>
		<img src="/images/large.jpg" width="1200" height="800" alt="Large image"><h6>End note</h6>
		<table><caption>Table</caption><tr><th>Column</th><td>Value</td></tr></table>
		"""

		let sanitized = StructuredHTMLSanitizer.sanitize(html: html, baseURL: baseURL)
		#expect(sanitized.contains("<h1>Article title</h1>") && sanitized.contains("<h6>End note</h6>"))
		#expect(sanitized.contains("<h2>Heading</h2>"))
		#expect(sanitized.contains("<strong>bold</strong>"))
		#expect(sanitized.contains("<em>quiet</em>"))
		#expect(sanitized.contains("<ul><li>One</li><li>Two</li></ul>"))
		#expect(sanitized.contains("<ol><li>First</li></ol>"))
		#expect(sanitized.contains("<hr />"))
		#expect(sanitized.contains("<blockquote>Read slowly.</blockquote>"))
		#expect(sanitized.contains("<pre><code>let value = 1</code></pre>"))
		#expect(sanitized.contains("<figcaption>Caption</figcaption>"))
		#expect(sanitized.contains("<table><caption>Table</caption>"))
		#expect(sanitized.contains("href=\"https://example.com/story\""))
		#expect(sanitized.contains("src=\"https://example.com/images/small.jpg\""))
		#expect(sanitized.contains("srcset=\"https://example.com/images/small.jpg 1x, https://cdn.example/large.jpg 2x\""))
		#expect(sanitized.contains("width=\"24\"") && sanitized.contains("height=\"24\""))

		let linkedImageHTML = #"<a href="/gallery"><img src="/images/normal.jpg" alt="Large linked image"></a>"#
		let linkedImage = StructuredHTMLSanitizer.sanitize(html: linkedImageHTML, baseURL: baseURL)
		#expect(linkedImage.contains("<a href=\"https://example.com/gallery\">"))
		#expect(linkedImage.contains("src=\"https://example.com/images/normal.jpg\""))

		let imageURLs = StructuredHTMLSanitizer.imageURLs(in: html, baseURL: baseURL)
		#expect(imageURLs == [
			try #require(URL(string: "https://example.com/images/small.jpg")),
			try #require(URL(string: "https://cdn.example/large.jpg")),
			try #require(URL(string: "https://example.com/images/large.jpg")),
		])
	}

	@Test
	func normalizesLazyImageSourcesAndSrcsetsWithDeterministicPrecedence() throws {
		let baseURL = try #require(URL(string: "https://example.com/newsletter/issue"))
		let html = #"<img data-src="/images/lazy.jpg" data-original="/images/original.jpg" data-lazy-src="/images/fallback.jpg" data-srcset="/images/lazy-small.jpg 1x, /images/lazy-large.jpg 2x" data-lazy-srcset="/images/fallback.jpg 1x" alt="Lazy">"#

		let sanitized = StructuredHTMLSanitizer.sanitize(html: html, baseURL: baseURL)
		#expect(sanitized.contains("src=\"https://example.com/images/lazy.jpg\""))
		#expect(sanitized.contains("srcset=\"https://example.com/images/lazy-small.jpg 1x, https://example.com/images/lazy-large.jpg 2x\""))
		#expect(sanitized.contains("data-src") == false)
		#expect(sanitized.contains("data-original") == false)
		#expect(sanitized.contains("data-lazy-src") == false)
		#expect(sanitized.contains("data-srcset") == false)
		#expect(StructuredHTMLSanitizer.imageURLs(in: html, baseURL: baseURL) == [
			try #require(URL(string: "https://example.com/images/lazy.jpg")),
			try #require(URL(string: "https://example.com/images/lazy-small.jpg")),
			try #require(URL(string: "https://example.com/images/lazy-large.jpg")),
		])
	}

	@Test
	func removesActiveContentHandlersAndUnsafeURLsWhileKeepingBrokenImagesVisibleToThePolicy() throws {
		let baseURL = try #require(URL(string: "https://example.com/article"))
		let html = """
		<p style="color:red" onclick="alert(1)">Safe text</p>
		<script>alert('xss')</script><iframe src="https://evil.example/frame"></iframe>
		<form action="https://evil.example"><input value="secret"></form>
		<img src="javascript:alert(1)" onerror="alert(1)"><img src="/broken.jpg" alt="Broken">
		<a href="javascript:alert(1)">Bad link</a><a href="/safe">Safe link</a>
		"""

		let sanitized = StructuredHTMLSanitizer.sanitize(html: html, baseURL: baseURL)
		#expect(sanitized.contains("Safe text"))
		#expect(sanitized.contains("style=") == false)
		#expect(sanitized.contains("onclick=") == false)
		#expect(sanitized.contains("script") == false)
		#expect(sanitized.contains("iframe") == false)
		#expect(sanitized.contains("form") == false)
		#expect(sanitized.contains("input") == false)
		#expect(sanitized.contains("javascript:") == false)
		#expect(sanitized.contains("href=\"https://example.com/safe\""))
		#expect(sanitized.contains("alt=\"Broken\""))
		#expect(StructuredHTMLSanitizer.imageURLs(in: html, baseURL: baseURL) == [try #require(URL(string: "https://example.com/broken.jpg"))])
	}

	@Test
	func decodesDoubleEscapedAndNumericAttributeReferencesBeforeValidation() throws {
		let baseURL = try #require(URL(string: "https://example.com/article"))
		let html = #"<a href="/story?width=1200&amp;amp;q=80" title="Say &amp;quot;hello&amp;quot; &#38; goodbye">Read &amp;amp; more</a><img src="/image?w=1200&amp;amp;q=80" alt="&amp;quot;Quote&amp;quot; &#x26; more" title="&#34;Title&#34;"><a href="java&amp;#x73;cript:alert(1)">Unsafe</a>"#

		let sanitized = StructuredHTMLSanitizer.sanitize(html: html, baseURL: baseURL)
		#expect(sanitized.contains("href=\"https://example.com/story?width=1200&amp;q=80\""))
		#expect(sanitized.contains("title=\"Say &quot;hello&quot; &amp; goodbye\""))
		#expect(sanitized.contains("src=\"https://example.com/image?w=1200&amp;q=80\""))
		#expect(sanitized.contains("alt=\"&quot;Quote&quot; &amp; more\""))
		#expect(sanitized.contains("title=\"&quot;Title&quot;\""))
		#expect(sanitized.contains("amp;amp;amp") == false)
		#expect(sanitized.contains("href=\"javascript:") == false)
		#expect(StructuredHTMLSanitizer.imageURLs(in: html, baseURL: baseURL) == [
			try #require(URL(string: "https://example.com/image?w=1200&q=80")),
		])
	}

	@Test
	func renderingShellConstrainsNewsletterTablesAndImagesToTheViewport() {
		let shell = StructuredHTMLJavaScript.renderingShell
		#expect(shell.contains("width=device-width"))
		#expect(shell.contains("max-width: 100%"))
		#expect(shell.contains("width: max-content") == false)
		#expect(shell.contains("table-layout: fixed"))
		#expect(shell.contains("max-width: 100% !important"))
	}

	@Test
	func renderingShellDoesNotStyleNewsletterLayoutCellsAsDataCells() {
		let shell = StructuredHTMLJavaScript.renderingShell

		#expect(shell.contains("th, td { border: 1px") == false)
		#expect(shell.contains("pigeon-layout-table"))
		#expect(shell.contains("pigeon-data-table"))
	}

	@MainActor
	@Test
	func renderingShellSeparatesNewsletterLayoutTablesFromDataTables() async throws {
		let webView = WKWebView()
		let navigationWaiter = StructuredHTMLNavigationWaiter()
		webView.navigationDelegate = navigationWaiter
		try await navigationWaiter.load(StructuredHTMLJavaScript.renderingShell, in: webView)

		let result = try await webView.evaluateJavaScript("""
			JSON.stringify((() => {
				const host = document.createElement("div");
				host.innerHTML = `
					<table id="layout"><tr><td><table><tr><td>Newsletter copy</td></tr></table></td></tr></table>
					<table id="data"><caption>Totals</caption><tr><th>Week</th><td>42</td></tr></table>
				`;
				document.getElementById("pigeon-content").replaceChildren(host);
				__pigeonPrepareTables(host);
				const layout = document.getElementById("layout");
				const data = document.getElementById("data");
				const layoutCell = layout.rows[0].cells[0];
				const dataCell = data.rows[0].cells[0];
				return {
					layoutClass: layout.className,
					dataClass: data.className,
					layoutParentClass: layout.parentElement.className,
					dataParentClass: data.parentElement.className,
					layoutBorderWidth: getComputedStyle(layoutCell).borderTopWidth,
					dataBorderWidth: getComputedStyle(dataCell).borderTopWidth,
				};
			})())
			""")
		let json = try #require(result as? String)
		let data = try #require(json.data(using: .utf8))
		let values = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])

		#expect(values["layoutClass"] == "pigeon-layout-table")
		#expect(values["dataClass"] == "pigeon-data-table")
		#expect(values["layoutParentClass"] != "table-scroll")
		#expect(values["dataParentClass"] == "table-scroll")
		#expect(values["layoutBorderWidth"] == "0px")
		#expect(values["dataBorderWidth"] == "1px")
	}

	@Test func renderingShellSupportsExplicitThemesBlockedImagesAndTheAuthenticatedProxyScheme() {
		let shell = StructuredHTMLJavaScript.renderingShell

		#expect(shell.contains("body[data-theme=\"sepia\"]"))
		#expect(shell.contains("document.body.dataset.theme = payload.theme || \"system\""))
		#expect(shell.contains("body[data-theme=\"dark-gray\"] { background: #1c1c1e; color: #f2f2f7; }"))
		#expect(shell.contains("body[data-theme=\"dark-gray\"] a { color: #64d2ff; }"))
		#expect(shell.contains("body[data-theme=\"dark-gray\"] pre"))
		#expect(shell.contains("payload.remoteImagePolicy === \"blocked\""))
		#expect(shell.contains("Load this remote image"))
		#expect(shell.contains("target.closest(\".pigeon-image-blocked\")"))
		#expect(shell.contains("payload.remoteImagePolicy === \"privacy-proxied\""))
		#expect(shell.contains("pigeon-image://proxy?url="))
		#expect(shell.contains("image.dataset.pigeonOriginalSrc"))
		#expect(shell.contains("image.dataset.pigeonOriginalSrc || image.currentSrc || image.src"))
		#expect(shell.contains("add(image.dataset.pigeonOriginalSrc)"))
		#expect(shell.contains("__pigeonSafeURL(image.dataset.pigeonOriginalSrc, document.baseURI)"))
	}

	@MainActor
	@Test
	func privacyProxyImageFailureReportsOriginalHTTPSIdentityAndRejectsUnsafeSchemes() async throws {
		let body = try #require(URL(string: "https://cdn.example/body.jpg"))
		let lead = try #require(URL(string: "https://cdn.example/lead.jpg"))
		let coordinator = StructuredHTMLView.Coordinator(
			onLink: { _ in },
			onImage: { _, _ in },
			onImageFailure: { _ in },
			onHeight: { _ in },
		)
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .nonPersistent()
		configuration.defaultWebpagePreferences.allowsContentJavaScript = true
		configuration.userContentController.add(coordinator, name: "pigeonEvent")
		let webView = WKWebView(frame: .zero, configuration: configuration)
		coordinator.webView = webView
		let navigationWaiter = StructuredHTMLNavigationWaiter()
		webView.navigationDelegate = navigationWaiter
		try await navigationWaiter.load(StructuredHTMLJavaScript.renderingShell, in: webView)

		let proxiedFailureURLs = await withCheckedContinuation { (continuation: CheckedContinuation<[URL], Never>) in
			coordinator.onImageFailure = { urls in
				continuation.resume(returning: urls)
			}
			webView.evaluateJavaScript("""
				window.__pigeonRender({
					html: '<img src="\(body.absoluteString)" alt="Body">',
					baseURL: "https://example.com/story",
					textScale: 1,
					lineHeight: 1.55,
					theme: "system",
					remoteImagePolicy: "privacy-proxied",
				});
				document.querySelector("img")?.dispatchEvent(new Event("error"));
			""", completionHandler: nil)
		}

		#expect(proxiedFailureURLs == [body])
		#expect(StructuredHTMLSanitizer.safeWebURL("pigeon-image://proxy?url=https%3A%2F%2Fcdn.example%2Fbody.jpg", relativeTo: nil) == nil)
		#expect(StructuredHTMLSanitizer.safeWebURL("javascript:alert(1)", relativeTo: nil) == nil)
		#expect(ArticleImagePolicy.fallbackLeadImageURL(
			bodyImageURLs: [body],
			leadImageURL: lead,
			failedImageURLs: Set(proxiedFailureURLs.map(\.absoluteString)),
		) == lead)

		let unsafeFailureURLs = await withCheckedContinuation { (continuation: CheckedContinuation<[URL], Never>) in
			coordinator.onImageFailure = { urls in
				continuation.resume(returning: urls)
			}
			webView.evaluateJavaScript("""
				const image = document.createElement("img");
				image.dataset.pigeonOriginalSrc = "javascript:alert(1)";
				image.src = "pigeon-image://proxy?url=javascript%3Aalert(1)";
				document.getElementById("pigeon-content").replaceChildren(image);
				image.dispatchEvent(new Event("error"));
			""", completionHandler: nil)
		}
		#expect(unsafeFailureURLs.isEmpty)
	}

	@MainActor
	@Test
	func askBeforeLoadingPlaceholderLoadsALinkedImageInsteadOfOpeningTheLink() async throws {
		let webView = WKWebView()
		let navigationWaiter = StructuredHTMLNavigationWaiter()
		webView.navigationDelegate = navigationWaiter
		try await navigationWaiter.load(StructuredHTMLJavaScript.renderingShell, in: webView)

		let result = try await webView.evaluateJavaScript("""
			JSON.stringify((() => {
				window.__pigeonPosts = [];
				window.webkit = {
					messageHandlers: {
						pigeonEvent: {
							postMessage: (message) => window.__pigeonPosts.push(message),
						},
					},
				};

				window.__pigeonRender({
					html: '<p><a href="https://example.com/gallery"><img src="https://cdn.example/hero.jpg" alt="Hero"></a></p>',
					baseURL: "https://example.com/story",
					textScale: 1,
					lineHeight: 1.55,
					theme: "system",
					remoteImagePolicy: "blocked",
				});

				const placeholder = document.querySelector(".pigeon-image-blocked");
				if (!placeholder) {
					return { error: "missing-placeholder" };
				}
				placeholder.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
				return {
					placeholderCount: String(document.querySelectorAll(".pigeon-image-blocked").length),
					imageCount: String(document.querySelectorAll("img").length),
					imageSrc: document.querySelector("img")?.getAttribute("src") || "",
					linkPosts: String(window.__pigeonPosts.filter((post) => post.kind === "link").length),
				};
			})())
			""")
		let json = try #require(result as? String)
		let data = try #require(json.data(using: .utf8))
		let values = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])

		#expect(values["error"] == nil)
		#expect(values["placeholderCount"] == "0")
		#expect(values["imageCount"] == "1")
		#expect(values["imageSrc"] == "https://cdn.example/hero.jpg")
		#expect(values["linkPosts"] == "0")
	}
}

@MainActor
private final class StructuredHTMLNavigationWaiter: NSObject, WKNavigationDelegate {
	private var continuation: CheckedContinuation<Void, any Error>?

	func load(_ html: String, in webView: WKWebView) async throws {
		try await withCheckedThrowingContinuation { continuation in
			self.continuation = continuation
			webView.loadHTMLString(html, baseURL: nil)
		}
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		continuation?.resume()
		continuation = nil
	}

	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
		continuation?.resume(throwing: error)
		continuation = nil
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
		continuation?.resume(throwing: error)
		continuation = nil
	}
}
