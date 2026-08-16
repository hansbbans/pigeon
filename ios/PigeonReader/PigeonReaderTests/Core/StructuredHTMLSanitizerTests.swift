import Foundation
import Testing
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

	@Test func renderingShellSupportsExplicitThemesBlockedImagesAndTheAuthenticatedProxyScheme() {
		let shell = StructuredHTMLJavaScript.renderingShell

		#expect(shell.contains("body[data-theme=\"sepia\"]"))
		#expect(shell.contains("payload.remoteImagePolicy === \"blocked\""))
		#expect(shell.contains("Load this remote image"))
		#expect(shell.contains("payload.remoteImagePolicy === \"privacy-proxied\""))
		#expect(shell.contains("pigeon-image://proxy?url="))
	}
}
