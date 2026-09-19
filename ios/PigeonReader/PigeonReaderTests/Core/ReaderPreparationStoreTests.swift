import Foundation
import Testing

@testable import PigeonReader

@MainActor
struct ReaderPreparationStoreTests {
	@Test
	func preparationIsLocalAndInvalidatesWhenBodyOrSourceChanges() async throws {
		let store = ReaderPreparationStore(capacity: 3, byteCapacity: 1_000_000)
		let first = makeArticle(
			id: "story",
			html: #"<script>alert(1)</script><p>Read this paragraph.</p><img src="/image.jpg">"#,
			url: "https://example.com/first",
		)

		await store.prepare(article: first)
		let prepared = try #require(store.preparedBody(for: first))
		#expect(prepared.sanitizedHTML.contains("alert") == false)
		#expect(prepared.sanitizedHTML.contains("Read this paragraph."))
		#expect(prepared.imageURLs == [try #require(URL(string: "https://example.com/image.jpg"))])

		let changedBody = makeArticle(
			id: first.id,
			html: "<p>A changed paragraph.</p>",
			url: first.originalURL?.absoluteString ?? "https://example.com/first",
		)
		#expect(store.preparedBody(for: changedBody) == nil)
		let changedSource = makeArticle(
			id: first.id,
			html: first.html,
			url: "https://example.com/second",
		)
		#expect(store.preparedBody(for: changedSource) == nil)
	}

	@Test
	func readerDocumentsAndScrollAnchorsShareTheSameBoundedContentKey() async throws {
		let store = ReaderPreparationStore(capacity: 2, byteCapacity: 1_000_000)
		let article = makeArticle(id: "story", html: "<p>Body</p>", url: "https://example.com/story")
		let document = try ReaderViewDocument(contentHTML: "<p>Reader body</p>")
		let anchor = ReaderScrollAnchor(id: "p-1", distanceFromTop: 12)

		store.cacheReaderDocument(document, for: article)
		store.cacheScrollAnchor(anchor, for: article, mode: ReaderMode.readerView.rawValue)
		#expect(store.cachedReaderDocument(for: article) == document)
		#expect(store.scrollAnchor(for: article, mode: ReaderMode.readerView.rawValue) == anchor)

		store.reset()
		#expect(store.cachedReaderDocument(for: article) == nil)
		#expect(store.scrollAnchor(for: article, mode: ReaderMode.readerView.rawValue) == nil)
	}

	@Test
	func leastRecentlyUsedEntriesAreEvictedByByteBudget() async {
		let store = ReaderPreparationStore(capacity: 3, byteCapacity: 700)
		let first = makeArticle(id: "first", html: "<p>\(String(repeating: "a", count: 300))</p>", url: "https://example.com/one")
		let second = makeArticle(id: "second", html: "<p>\(String(repeating: "b", count: 300))</p>", url: "https://example.com/two")

		await store.prepare(article: first)
		await store.prepare(article: second)
		#expect(store.preparedBody(for: first) == nil)
		#expect(store.preparedBody(for: second) != nil)
	}

	private func makeArticle(id: String, html: String, url: String) -> Recommendation {
		Recommendation(
			id: id,
			readerId: id,
			feedKey: "feed",
			source: "Source",
			title: "Title",
			html: html,
			text: "Text",
			originalURL: URL(string: url),
			receivedAt: Date(timeIntervalSince1970: 0),
			isRead: false,
			isStarred: false,
			score: 0,
			confidence: 0,
			sampleCount: 0,
			explanation: "",
			learningState: "",
		)
	}
}
