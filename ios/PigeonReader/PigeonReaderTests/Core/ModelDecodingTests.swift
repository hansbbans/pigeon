import Foundation
import Testing
@testable import PigeonReader

struct ModelDecodingTests {
	@Test func unsafeOriginalURLIsNotOpened() throws {
		let unsafeURL = URL(string: "javascript:alert(1)")!
		let recommendation = Recommendation(
			id: "item-1",
			readerId: "reader-1",
			feedKey: "daily",
			source: "Daily",
			title: "Story",
			html: "<p>Body</p>",
			text: "Body",
			originalURL: unsafeURL,
			receivedAt: .now,
			isRead: false,
			isStarred: false,
			score: 50,
			confidence: 0,
			sampleCount: 0,
			explanation: "Starting with recency",
			learningState: "Starting with recency",
		)

		#expect(recommendation.safeOriginalURL == nil)
	}

	@Test func outboundDestinationAcceptsWebLinksAndKeepsOnlyNormalizedHost() throws {
		let url = try #require(URL(string: "https://News.Example.com./private/path?token=secret"))
		let destination = try #require(OutboundDestination(url: url))

		#expect(destination.host == "news.example.com")
		#expect(destination.host.contains("private") == false)
		#expect(OutboundDestination(url: URL(string: "javascript:alert(1)")!) == nil)
	}

	@Test func articleFormattingRemovesPublisherPresentationWithoutDroppingInlineLinks() throws {
		let expectedURL = try #require(URL(string: "https://example.com/story"))
		let rendered = ArticleContentFormatter.make(
			html: "<p style='font-family: Papyrus; color: red'><a href='https://example.com/story'>Story</a></p>",
			fallback: "Story"
		)
		let links = rendered.runs.compactMap(\.link)

		#expect(links == [expectedURL])
	}

	@Test func displayAuthorIgnoresBlankNamesAndFeedTitleRepeats() {
		#expect(Recommendation.displayAuthor(nil, source: "Daily") == nil)
		#expect(Recommendation.displayAuthor("", source: "Daily") == nil)
		#expect(Recommendation.displayAuthor("   ", source: "Daily") == nil)
		#expect(Recommendation.displayAuthor("Daily", source: "Daily") == nil)
		#expect(Recommendation.displayAuthor("daily", source: "Daily") == nil)
		#expect(Recommendation.displayAuthor("Alice Appleseed", source: "Daily") == "Alice Appleseed")
		#expect(Recommendation.displayAuthor("  Alice Appleseed  ", source: "Daily") == "Alice Appleseed")
	}

	@Test func greaderBlankAuthorIsNotStoredAsAByline() throws {
		let data = Data(#"""
		{"id":"tag:google.com,2005:reader/item/0000000000000001","categories":[],"title":"A useful story","author":"","published":1786272000,"alternate":[],"origin":{"streamId":"feed/7","title":"Daily","htmlUrl":"https://example.com"}}
		"""#.utf8)
		let item = try JSONDecoder().decode(ReaderStreamItem.self, from: data)

		#expect(item.author == nil)
	}

	@Test func articleUsesDistinctAuthorAsTheVisibleByline() {
		let article = Recommendation(
			id: "item-1",
			readerId: "reader-1",
			feedKey: "daily",
			source: "Daily",
			author: "Alice Appleseed",
			title: "Story",
			html: "<p>Body</p>",
			text: "Body",
			originalURL: URL(string: "https://example.com/story"),
			receivedAt: .now,
			isRead: false,
			isStarred: false,
			score: 50,
			confidence: 0,
			sampleCount: 0,
			explanation: "From Daily",
			learningState: "Reader subscription",
		)

		#expect(article.displayAuthor == "Alice Appleseed")
	}
}
