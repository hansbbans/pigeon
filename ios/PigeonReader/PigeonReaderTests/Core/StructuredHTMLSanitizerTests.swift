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

	/// The app loads the shell with the article's https URL as its base (StructuredHTMLView). A font
	/// fetched from a custom scheme is blocked there as mixed content, so this covers that base too.
	@MainActor
	@Test(arguments: [nil, "https://example.com/2026/11/story", "http://example.com/2026/11/story"])
	func renderingShellSetsArticlesInTheChosenBundledTypeface(baseURL: String?) async throws {
		let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 420, height: 700))
		let navigationWaiter = StructuredHTMLNavigationWaiter()
		webView.navigationDelegate = navigationWaiter
		try await navigationWaiter.load(StructuredHTMLJavaScript.renderingShell, in: webView, baseURL: baseURL.flatMap(URL.init(string:)))
		for typeface in ReaderTypeface.allCases {
			_ = try await webView.evaluateJavaScript(try #require(ReaderWebFonts.installScript(for: typeface)))
		}

		// WebKit cannot see UIAppFonts fonts; without the pigeon-font faces every typeface measured
		// exactly like Iowan Old Style. Each face must measure unlike that fallback and unlike the other.
		let result = try await webView.callAsyncJavaScript("""
			const content = document.getElementById("pigeon-content");
			content.innerHTML = '<h2 id="h">Heading</h2><p><span id="t">Hamburgefonstiv quick brown</span> <strong><em id="s">bold italic</em></strong></p><span id="f" style="font-family: \\'Iowan Old Style\\'">Hamburgefonstiv quick brown</span>';
			const measure = async (typeface) => {
				if (typeface) document.body.dataset.typeface = typeface; else delete document.body.dataset.typeface;
				await document.fonts.ready;
				await Promise.all([...document.fonts].map(face => face.loaded));
				return {
					family: getComputedStyle(document.body).fontFamily,
					width: document.getElementById("t").getBoundingClientRect().width,
					boldItalicWidth: document.getElementById("s").getBoundingClientRect().width,
					headingWeight: getComputedStyle(document.getElementById("h")).fontWeight,
				};
			};
			const initial = await measure(null);
			const geist = await measure("geist-serif");
			const bookerly = await measure("bookerly");
			const allo = await measure("allo");
			const loaded = [...document.fonts].filter(face => face.status === "loaded").map(face => face.family.replace(/"/g, "") + " " + face.weight + " " + face.style).sort();
			return JSON.stringify({ fallback: document.getElementById("f").getBoundingClientRect().width, initial, geist, bookerly, allo, loaded });
			""", contentWorld: .page)
		let json = try #require(result as? String)
		let values = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
		let fallback = try #require(values["fallback"] as? Double)
		let initial = try #require(values["initial"] as? [String: Any])
		let geist = try #require(values["geist"] as? [String: Any])
		let bookerly = try #require(values["bookerly"] as? [String: Any])
		let geistWidth = try #require(geist["width"] as? Double)
		let bookerlyWidth = try #require(bookerly["width"] as? Double)
		let allo = try #require(values["allo"] as? [String: Any])
		let alloWidth = try #require(allo["width"] as? Double)

		#expect((initial["family"] as? String)?.hasPrefix("\"Geist Serif\"") == true)
		#expect(initial["width"] as? Double == geistWidth)
		#expect((bookerly["family"] as? String)?.hasPrefix("Bookerly") == true)
		#expect(abs(geistWidth - fallback) > 1, "Geist Serif must load, not fall back: \(json)")
		#expect(abs(bookerlyWidth - fallback) > 1, "Bookerly must load, not fall back: \(json)")
		#expect(abs(geistWidth - bookerlyWidth) > 1)
		#expect((allo["family"] as? String)?.hasPrefix("Allo") == true)
		#expect(abs(alloWidth - fallback) > 1, "Allo must load, not fall back: \(json)")
		#expect(abs(alloWidth - geistWidth) > 1)
		#expect(allo["headingWeight"] as? String == "600")
		#expect(geist["headingWeight"] as? String == "400")
		#expect(bookerly["headingWeight"] as? String == "700" || bookerly["headingWeight"] as? String == "bold")
		let loaded = try #require(values["loaded"] as? [String])
		#expect(loaded.contains("Geist Serif 400 normal"))
		#expect(loaded.contains("Bookerly 400 normal"))
		#expect(loaded.contains("Bookerly 700 italic"), "strong em uses Bookerly Bold Italic: \(loaded)")
		#expect(loaded.contains("Allo 400 normal"))
		#expect(loaded.contains("Allo 600 normal"), "headings use Allo SemiBold: \(loaded)")
		#expect(loaded.contains("Allo 700 italic"), "strong em uses Allo Bold Oblique: \(loaded)")
	}

	@MainActor
	@Test
	func webFontsCoverEveryFaceOfEachTypefaceAndAreBuiltOnce() throws {
		#expect(ReaderWebFonts.faces(for: .geistSerif).map(\.fileName) == ["GeistSerif-Regular"])
		#expect(ReaderWebFonts.faces(for: .bookerly).map(\.fileName) == ["Bookerly-Regular", "Bookerly-Bold", "Bookerly-Italic", "Bookerly-BoldItalic"])
		#expect(ReaderWebFonts.faces(for: .allo).map(\.fileName) == ["Allo-Regular", "Allo-SemiBold", "Allo-Bold", "Allo-Oblique", "Allo-BoldOblique"])
		#expect(ReaderWebFonts.faces(for: .allo).allSatisfy { $0.fileExtension == "otf" })
		for typeface in ReaderTypeface.allCases {
			let script = try #require(ReaderWebFonts.installScript(for: typeface))
			#expect(script.hasPrefix("window.__pigeonInstallFonts([{"))
			#expect(script.count > 100_000)
			#expect(ReaderWebFonts.installScript(for: typeface) == script)
		}
	}

	@MainActor
	@Test
	func installingFontsTwiceAddsEachFaceOnce() async throws {
		let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 420, height: 700))
		let navigationWaiter = StructuredHTMLNavigationWaiter()
		webView.navigationDelegate = navigationWaiter
		try await navigationWaiter.load(StructuredHTMLJavaScript.renderingShell, in: webView, baseURL: URL(string: "https://example.com/story"))
		let script = try #require(ReaderWebFonts.installScript(for: .bookerly))
		_ = try await webView.evaluateJavaScript(script)
		_ = try await webView.evaluateJavaScript(script)
		let count = try await webView.evaluateJavaScript("document.fonts.size")
		#expect(count as? Int == 4)
	}

	@MainActor
	@Test
	func paragraphsAndDOMSurviveImageAndTypographyRelayouts() async throws {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .nonPersistent()
		configuration.userContentController.add(ReaderLayoutMessageSink(), name: "pigeonEvent")
		let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 420, height: 700), configuration: configuration)
		let navigationWaiter = StructuredHTMLNavigationWaiter()
		webView.navigationDelegate = navigationWaiter
		try await navigationWaiter.load(StructuredHTMLJavaScript.renderingShell, in: webView)
		let result = try await webView.evaluateJavaScript("""
			(() => {
			  const html = '<p>First paragraph with enough words to wrap across several lines in a narrow reading column.</p><div></div><p>Second paragraph stays at the reading position.</p><p>Repeated text.</p><p>Repeated text.</p>';
			  const payload = {html, contentSignature: 'fixture-one', textScale: 1, lineHeight: 1.55, theme: 'light', remoteImagePolicy: 'normal'};
			  window.__pigeonRender(payload);
			  const root = document.getElementById('pigeon-content');
			  const rows = () => Array.from(root.querySelectorAll('[data-pigeon-anchor]')).map(e => ({ id:e.dataset.pigeonAnchor, top:e.getBoundingClientRect().top-root.getBoundingClientRect().top,height:e.getBoundingClientRect().height }));
			  const before = rows();
			  const firstNode = root.querySelector('p');
			  root.querySelector('div').style.height = '220px';
			  const afterImage = rows();
			  window.__pigeonRender({...payload, textScale:1.5,lineHeight:1.8});
			  const afterType = rows();
			  const result = {
			    anchorCount: before.length,
			    uniqueDuplicateParagraphs: before[2].id !== before[3].id,
			    imageKeepsIdentity: before.every((a,i) => a.id === afterImage[i].id),
			    imageShift: afterImage[1].top-before[1].top,
			    typeKeepsIdentity: before.every((a,i) => a.id === afterType[i].id),
			    typeChangesHeight: afterType[0].height > before[0].height,
			    preservesDOMForTypography: firstNode === root.querySelector('p')
			  };
			  window.__pigeonRender({...payload,html:'<p>Entirely different story.</p>', contentSignature:'fixture-two'});
			  result.newStoryReplacesAnchors = rows().length === 1 && rows()[0].id !== before[0].id;
			  return JSON.stringify(result);
			})()
			""")
		let json = try #require(result as? String)
		let data = try #require(json.data(using: .utf8))
		let values = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
		#expect(values["anchorCount"] as? Int == 4)
		let shift = try #require(values["imageShift"] as? Double)
		#expect(abs(shift - 220) < 1)
		for key in ["uniqueDuplicateParagraphs", "imageKeepsIdentity", "typeKeepsIdentity", "typeChangesHeight", "preservesDOMForTypography", "newStoryReplacesAnchors"] {
			#expect(values[key] as? Bool == true, "Continuity check: \(key)")
		}
	}

	@Test func renderingShellSupportsExplicitThemesBlockedImagesAndTheAuthenticatedProxyScheme() {
		let shell = StructuredHTMLJavaScript.renderingShell

		#expect(shell.contains("body[data-theme=\"sepia\"]"))
		#expect(shell.contains("document.body.dataset.theme = payload.theme || \"system\""))
		#expect(shell.contains("body[data-theme=\"dark-gray\"] { background: #1c1c1e; color: #f2f2f7; }"))
		#expect(shell.contains("body[data-theme=\"dark-gray\"] a { color: #64d2ff; }"))
		#expect(shell.contains("body[data-theme=\"dark-gray\"] pre"))
		#expect(shell.contains("policy === \"blocked\""))
		#expect(shell.contains("Load this remote image"))
		#expect(shell.contains("target.closest(\".pigeon-image-blocked\")"))
		#expect(shell.contains("policy === \"privacy-proxied\""))
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
			onLayout: { _ in },
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

	func load(_ html: String, in webView: WKWebView, baseURL: URL? = nil) async throws {
		try await withCheckedThrowingContinuation { continuation in
			self.continuation = continuation
			webView.loadHTMLString(html, baseURL: baseURL)
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

@MainActor
private final class ReaderLayoutMessageSink: NSObject, WKScriptMessageHandler {
	func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { }
}
