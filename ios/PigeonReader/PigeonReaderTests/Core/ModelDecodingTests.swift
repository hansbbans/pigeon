import Foundation
import Testing
@testable import PigeonReader

struct ModelDecodingTests {
	@Test func unsafeOriginalURLIsNotOpened() throws {
		let unsafeURL = try #require(URL(string: "javascript:alert(1)"))
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
		let unsafeURL = try #require(URL(string: "javascript:alert(1)"))
		#expect(OutboundDestination(url: unsafeURL) == nil)
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
}
