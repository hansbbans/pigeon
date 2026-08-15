import Foundation
import Testing
@testable import PigeonReader

@MainActor
struct ReaderViewExtractorTests {
	@Test
	func readabilityExtractsArticleAndStripsActiveContent() async throws {
		let html = """
		<!doctype html>
		<html onload="window.__pigeonRootHandler = true" style="color:red"><head><title>Readable title</title><meta property="og:image" content="/images/lead.jpg"></head>
		<body>
			<nav>Site navigation that should not be part of the story.</nav>
			<article>
				<h1>Readable title</h1>
				<p onclick="alert('bad')">The first paragraph has <strong>useful structure</strong>.</p>
				<p><a href="/related">A relative link</a></p>
				<img src="/images/inline.jpg" alt="Inline image">
				<script>window.__pigeonTestScript = true</script>
				<iframe src="https://evil.example/embed"></iframe>
				<form action="https://evil.example"><input value="secret"></form>
			</article>
		</body></html>
		"""
		let extractor = ReaderViewExtractor(
			httpClient: MockHTTPClient(responseData: Data(html.utf8)),
		)
		let document = try await extractor.extract(from: try #require(URL(string: "https://example.com/articles/story")))

		#expect(document.title == "Readable title")
		#expect(document.contentHTML.contains("<strong>useful structure</strong>"))
		#expect(document.contentHTML.contains("https://example.com/related"))
		#expect(document.contentHTML.contains("https://example.com/images/inline.jpg"))
		#expect(document.contentHTML.contains("script") == false)
		#expect(document.contentHTML.contains("iframe") == false)
		#expect(document.contentHTML.contains("form") == false)
		#expect(document.contentHTML.contains("onclick") == false)
		#expect(document.leadImageURL == URL(string: "https://example.com/images/lead.jpg"))
	}

	@Test
	func extractsReadableArticleFromFeedHTMLWhenTheOriginalPageIsMissing() async throws {
		let extractor = ReaderViewExtractor(
			httpClient: MockHTTPClient(responseData: Data(), statusCode: 404),
		)
		let document = try await extractor.extract(
			html: "<p>The cheapest fat loss tool most people sleep on is a walk after meals.</p><p>Consistency matters more than intensity for this habit.</p>",
			title: "4 Minute Fridays",
			baseURL: URL(string: "https://example.com/newsletter"),
		)

		#expect(document.contentHTML.contains("cheapest fat loss tool"))
		#expect(document.title == "4 Minute Fridays" || document.contentHTML.contains("4 Minute Fridays"))
	}

	@Test
	func keepsHiddenChromeHiddenSoNewsletterPagesStillExtract() async throws {
		let hiddenChrome = String(repeating: "Unsubscribe manage account privacy terms login share comment follow us. ", count: 20)
		let html = """
		<!doctype html>
		<html><head><title>4 Minute Fridays</title></head>
		<body>
			<div style="display:none">\(hiddenChrome)</div>
			<article>
				<h1>4 Minute Fridays</h1>
				<p>The cheapest fat loss tool most people sleep on is a walk after meals.</p>
				<p>What your poop says about your health is mostly about consistency and color.</p>
				<p>The toothpaste I use every day is just a fluoride paste without extra claims.</p>
			</article>
		</body></html>
		"""
		let extractor = ReaderViewExtractor(
			httpClient: MockHTTPClient(responseData: Data(html.utf8)),
		)
		let document = try await extractor.extract(from: try #require(URL(string: "https://example.com/p/4-minute-fridays")))

		#expect(document.contentHTML.contains("cheapest fat loss tool"))
		#expect(document.contentHTML.contains("Unsubscribe manage account") == false)
	}

	@Test
	func readabilityFailureIsDeterministicWhenThePageHasNoUsableArticle() async throws {
		let extractor = ReaderViewExtractor(
			httpClient: MockHTTPClient(responseData: Data("<html><head></head><body></body></html>".utf8)),
		)
		let url = try #require(URL(string: "https://example.com/empty"))

		await #expect(throws: ReaderViewError.extractionFailed) {
			try await extractor.extract(from: url)
		}
	}

	@Test
	func resolvesRelativeReaderViewContentAgainstTheFinalRedirectURL() async throws {
		let html = """
		<html><head><title>Redirected story</title></head><body>
		<article>
			<h1>Redirected story</h1>
			<p>A <a href="related">relative link</a> stays attached to the final page.</p>
			<img src="images/inline.jpg" alt="Inline image">
		</article>
		</body></html>
		"""
		let finalURL = try #require(URL(string: "https://news.example/archives/2026/story"))
		let extractor = ReaderViewExtractor(
			httpClient: MockHTTPClient(responseData: Data(html.utf8), responseURL: finalURL),
		)

		let document = try await extractor.extract(from: try #require(URL(string: "https://news.example/short-link")))

		#expect(document.contentHTML.contains("https://news.example/archives/2026/related"))
		#expect(document.contentHTML.contains("https://news.example/archives/2026/images/inline.jpg"))
	}

	@Test
	func concurrentExtractionsUseIndependentNavigationSessions() async throws {
		let firstURL = try #require(URL(string: "https://example.com/first"))
		let secondURL = try #require(URL(string: "https://example.com/second"))
		let client = RoutingHTTPClient(responses: [
			firstURL: Data("<html><head><title>First story</title></head><body><article><h1>First story</h1><p>First body.</p></article></body></html>".utf8),
			secondURL: Data("<html><head><title>Second story</title></head><body><article><h1>Second story</h1><p>Second body.</p></article></body></html>".utf8),
		])
		let extractor = ReaderViewExtractor(httpClient: client)

		async let first = extractor.extract(from: firstURL)
		async let second = extractor.extract(from: secondURL)
		let (firstDocument, secondDocument) = try await (first, second)

		#expect(firstDocument.title == "First story")
		#expect(firstDocument.contentHTML.contains("First body."))
		#expect(secondDocument.title == "Second story")
		#expect(secondDocument.contentHTML.contains("Second body."))
	}
}

private actor RoutingHTTPClient: HTTPClient {
	private let responses: [URL: Data]

	init(responses: [URL: Data]) {
		self.responses = responses
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let url = request.url, let data = responses[url] else {
			throw URLError(.fileDoesNotExist)
		}
		guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/html"]) else {
			throw URLError(.badServerResponse)
		}
		return (data, response)
	}
}
