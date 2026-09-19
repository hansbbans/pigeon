import Foundation
import Testing
@testable import PigeonReader

struct ReaderSidebarFeedPreviewDataTests {
	@Test func distinguishesAnUncachedCollectionFromAnEmptyCachedCollection() {
		let feed = makeFeed(unreadCount: 4)

		let uncached = ReaderSidebarFeedPreviewData.make(feed: feed, cachedArticles: nil)
		let empty = ReaderSidebarFeedPreviewData.make(feed: feed, cachedArticles: [])

		#expect(uncached.cacheState == .uncached)
		#expect(empty.cacheState == .empty)
		#expect(uncached.title == feed.title)
		#expect(uncached.unreadCount == 4)
	}

	@Test func previewKeepsOnlyTheFirstThreeCachedHeadlinesInOrder() throws {
		let feed = makeFeed(unreadCount: 2)
		let articles = (1...5).map { number in
			makeArticle(id: "article-\(number)", title: number == 2 ? "  Second headline  " : "Headline \(number)")
		}

		let data = ReaderSidebarFeedPreviewData.make(feed: feed, cachedArticles: articles)
		guard case .loaded(let headlines) = data.cacheState else {
			Issue.record("Expected cached headlines")
			return
		}

		#expect(headlines.map(\.title) == ["Headline 1", "Second headline", "Headline 3"])
		#expect(headlines.map(\.id) == ["article-1", "article-2", "article-3"])
	}

	@Test func blankHeadlineGetsAnHonestFallbackWithoutChangingTheCacheState() {
		let feed = makeFeed()
		let article = makeArticle(id: "article", title: "\n  \t")

		let data = ReaderSidebarFeedPreviewData.make(feed: feed, cachedArticles: [article])

		#expect(data.cacheState == .loaded([
			ReaderSidebarFeedPreviewData.Headline(id: "article", title: "Untitled story"),
		]))
	}

	private func makeFeed(unreadCount: Int = 1) -> ReaderNavigationItem {
		ReaderNavigationItem(
			id: "feed/preview",
			title: "Example Feed",
			streamID: "feed/preview",
			kind: .feed,
			unreadCount: unreadCount,
			parentID: nil,
			feedKey: "example-feed",
			iconURL: nil,
			smartSection: nil,
		)
	}

	private func makeArticle(id: String, title: String) -> Recommendation {
		Recommendation(
			id: id,
			readerId: id,
			feedKey: "example-feed",
			source: "Example Feed",
			title: title,
			html: "<p>Story</p>",
			text: "Story",
			originalURL: nil,
			receivedAt: .now,
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
