import Foundation
import Testing
@testable import PigeonReader

struct ReaderKeptArticlesTests {
	@Test func keptRowStaysAtItsRowWhileStillCached() {
		var kept = ReaderKeptArticles()
		var stories = makeStories(["a", "b", "c"])
		stories[1].isRead = true
		kept.keep(stories[1], in: "feed/1", filter: .unread, at: 1)

		let displayed = kept.displayed(stories, filter: .unread, order: .oldest)

		#expect(displayed.map(\.id) == ["a", "b", "c"])
		#expect(ReaderArticleFilter.unread.filtering(stories).map(\.id) == ["a", "c"])
	}

	@Test func missingKeptRowReturnsAtItsSortedPosition() {
		var kept = ReaderKeptArticles()
		var stories = makeStories(["a", "b", "c", "d"])
		stories[2].isRead = true
		kept.keep(stories[2], in: "feed/1", filter: .unread, at: 2)

		let newest = kept.displayed([stories[3], stories[1], stories[0]], filter: .unread, order: .newest)
		let oldest = kept.displayed([stories[0], stories[1], stories[3]], filter: .unread, order: .oldest)

		#expect(newest.map(\.id) == ["d", "c", "b", "a"])
		#expect(oldest.map(\.id) == ["a", "b", "c", "d"])
	}

	@Test func missingKeptRowsInRecommendedOrderReturnToTheirRecordedRows() {
		var kept = ReaderKeptArticles()
		var stories = makeStories(["a", "b", "c", "d"])
		stories[0].isRead = true
		stories[2].isRead = true
		kept.keep(stories[2], in: "for-you", filter: .unread, at: 2)
		kept.keep(stories[0], in: "for-you", filter: .unread, at: 0)

		let displayed = kept.displayed([stories[1], stories[3]], filter: .unread, order: .recommended)

		#expect(displayed.map(\.id) == ["a", "b", "c", "d"])
	}

	@Test func keptRowsMatchAnyIdentityAlias() {
		var kept = ReaderKeptArticles()
		let story = makeStories(["a"])[0]
		kept.keep(story, in: "feed/1", filter: .unread, at: 0)
		let byReaderID = makeStories(["a"])[0]

		#expect(kept.contains(byReaderID))
		#expect(kept.article(withID: "tag:google.com,2005:reader/item/a") != nil)
		#expect(kept.article(withID: "A") != nil)
	}

	@Test func updatesRefreshTheRetainedCopy() {
		var kept = ReaderKeptArticles()
		var story = makeStories(["a"])[0]
		story.isRead = true
		kept.keep(story, in: "feed/1", filter: .unread, at: 0)
		var starred = story
		starred.isStarred = true

		kept.update(from: [starred])

		#expect(kept.displayed([], filter: .unread, order: .newest).first?.isStarred == true)
	}

	@Test func keptRowsApplyOnlyToTheirListAndFilter() {
		var kept = ReaderKeptArticles()
		let story = makeStories(["a"])[0]
		#expect(kept.applies(to: "feed/1", filter: .unread) == false)

		kept.keep(story, in: "feed/1", filter: .unread, at: 0)
		#expect(kept.applies(to: "feed/1", filter: .unread))
		#expect(kept.applies(to: "feed/1", filter: .all) == false)
		#expect(kept.applies(to: "feed/2", filter: .unread) == false)

		kept.keep(story, in: "feed/2", filter: .read, at: 0)
		#expect(kept.applies(to: "feed/1", filter: .unread) == false)
		#expect(kept.applies(to: "feed/2", filter: .read))

		kept.reset()
		#expect(kept.isEmpty)
		#expect(kept.applies(to: "feed/2", filter: .read) == false)
	}

	@Test func removedKeptRowsDoNotReturn() {
		var kept = ReaderKeptArticles()
		var stories = makeStories(["a", "b", "c"])
		stories[0].isRead = true
		stories[1].isRead = true
		kept.keep(stories[0], in: "feed/1", filter: .unread, at: 0)
		kept.keep(stories[1], in: "feed/1", filter: .unread, at: 1)

		kept.remove(stories[0])
		#expect(kept.displayed([stories[2]], filter: .unread, order: .oldest).map(\.id) == ["b", "c"])
		kept.removeAll { $0.id == "b" }

		#expect(kept.isEmpty)
		#expect(kept.displayed([stories[2]], filter: .unread, order: .oldest).map(\.id) == ["c"])
	}

	@Test func ineligibleMissingRowsStayOut() {
		var kept = ReaderKeptArticles()
		var stories = makeStories(["a", "b"])
		stories[0].isRead = true
		kept.keep(stories[0], in: "today", filter: .unread, at: 0)

		let displayed = kept.displayed([stories[1]], filter: .unread, order: .oldest, isEligible: { _ in false })

		#expect(displayed.map(\.id) == ["b"])
	}

	@Test func manyMissingRowsInsertAtTheirSortedRows() {
		var kept = ReaderKeptArticles()
		var stories = makeStories((0..<20).map { "s\($0)" })
		for index in stride(from: 1, to: 20, by: 3) {
			stories[index].isRead = true
			kept.keep(stories[index], in: "unread", filter: .unread, at: index)
		}
		let remaining = stories.filter { $0.isRead == false }

		#expect(kept.displayed(remaining.reversed(), filter: .unread, order: .newest).map(\.id)
			== stories.reversed().map(\.id))
		#expect(kept.displayed(remaining, filter: .unread, order: .oldest).map(\.id) == stories.map(\.id))
	}

	@Test func aRefreshedSpellingStillMatchesItsCachedRow() {
		var kept = ReaderKeptArticles()
		var story = makeStories(["a"])[0]
		story.isRead = true
		kept.keep(story, in: "feed/1", filter: .unread, at: 0)
		let respelled = Recommendation(
			id: "A", readerId: "tag:google.com,2005:reader/item/a", feedKey: "daily", source: "Daily",
			title: "Story a", html: "<p>Body</p>", text: "Body", originalURL: nil,
			receivedAt: story.receivedAt, isRead: false, isStarred: false, score: 50,
			confidence: 0, sampleCount: 0, explanation: "", learningState: "",
		)

		kept.update(from: [respelled])

		#expect(kept.displayed([respelled], filter: .unread, order: .oldest).map(\.id) == ["A"])
	}

	private func makeStories(_ ids: [String]) -> [Recommendation] {
		ids.enumerated().map { index, id in
			Recommendation(
				id: id,
				readerId: "tag:google.com,2005:reader/item/\(id)",
				feedKey: "daily",
				source: "Daily",
				title: "Story \(id)",
				html: "<p>Body</p>",
				text: "Body",
				originalURL: nil,
				receivedAt: Date(timeIntervalSince1970: 1_786_272_000 + Double(index)),
				isRead: false,
				isStarred: false,
				score: 50,
				confidence: 0,
				sampleCount: 0,
				explanation: "Starting with recency",
				learningState: "Starting with recency",
			)
		}
	}
}
