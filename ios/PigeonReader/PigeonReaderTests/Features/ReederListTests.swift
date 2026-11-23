import Foundation
import SwiftUI
import Testing
@testable import PigeonReader

/// The Reeder look's list rules: read rows go compact only when a list first
/// shows them read, the reading log's tags, and a regular window without Home.
struct ReederListTests {
	// MARK: Compact read rows

	@Test func aStoryReadBeforeTheListShowedItIsCompact() {
		let memory = ReaderFullRowMemory()
		#expect(memory.isCompact(story("read", isRead: true), in: "list"))
		#expect(memory.isCompact(story("unread"), in: "list") == false)
	}

	@Test func aStoryReadWhileShownKeepsItsFullHeight() {
		var memory = ReaderFullRowMemory()
		memory.noteDrawn([story("a"), story("b", isRead: true)], in: "list")

		// "a" was drawn in full; reading it must not shrink the row.
		#expect(memory.isCompact(story("a", isRead: true), in: "list") == false)
		#expect(memory.isCompact(story("b", isRead: true), in: "list"))
		// Each list remembers its own rows.
		#expect(memory.isCompact(story("a", isRead: true), in: "other"))
	}

	@Test func aStoryMarkedUnreadAndReadAgainStaysFull() {
		var memory = ReaderFullRowMemory()
		memory.noteDrawn([story("a", isRead: true)], in: "list")
		#expect(memory.isCompact(story("a", isRead: true), in: "list"))

		memory.noteDrawn([story("a")], in: "list")
		#expect(memory.isCompact(story("a", isRead: true), in: "list") == false)

		memory.removeAll()
		#expect(memory.isCompact(story("a", isRead: true), in: "list"))
	}

	// MARK: Reading log tags

	@Test func sectionedListsTagEachStoryWithItsFirstSectionAndCompactRows() {
		let todayStart = ReaderLocalDayBounds.localDay(containing: Date()).start
		let now = todayStart.addingTimeInterval(43_200)
		let sections = FolderSections.make(
			articles: [
				story("today", feed: "feed/1", at: todayStart.addingTimeInterval(60)),
				story("week", feed: "feed/1", at: todayStart.addingTimeInterval(-3_600), isRead: true),
				story("old", feed: "feed/2", at: todayStart.addingTimeInterval(-30 * 86_400)),
			],
			feeds: .empty, now: now,
		)

		let tags = ReaderListReadingLogTags(sections: sections, articles: [], isCompact: { $0.isRead })

		// "today" is also in feed/1's section; it counts where it first shows.
		#expect(tags.sections == ["today": "today", "week": "last-7-days", "old": "feed"])
		#expect(tags.rows == ["week": "compact"])
	}

	@Test func aFeedsDaySectionsAreLoggedAsDays() {
		let todayStart = ReaderLocalDayBounds.localDay(containing: Date()).start
		let sections = FeedDaySections.make(
			articles: [
				story("now", feed: "feed/1", at: todayStart.addingTimeInterval(60)),
				story("before", feed: "feed/1", at: todayStart.addingTimeInterval(-5 * 86_400)),
			],
			now: todayStart.addingTimeInterval(43_200),
		)

		let tags = ReaderListReadingLogTags(sections: sections, articles: [], isCompact: { _ in false })

		#expect(tags.sections == ["now": "day", "before": "day"])
		#expect(tags.rows.isEmpty)
	}

	@Test func aFlatListHasNoSections() {
		let articles = [story("a"), story("b", isRead: true)]

		let tags = ReaderListReadingLogTags(sections: nil, articles: articles, isCompact: { $0.isRead })

		#expect(tags.sections.isEmpty)
		#expect(tags.rows == ["b": "compact"])
	}

	// MARK: No Home in a regular window

	@Test func aRegularWindowOpensTheListInsteadOfHome() {
		#expect(ReaderCompactArticlePresentation.columnWithoutHome(horizontalSizeClass: .regular, preferredColumn: .sidebar) == .content)
		#expect(ReaderCompactArticlePresentation.columnWithoutHome(horizontalSizeClass: .regular, preferredColumn: .detail) == .detail)
		// A phone (and Cards, which navigates as compact) keeps the library root.
		#expect(ReaderCompactArticlePresentation.columnWithoutHome(horizontalSizeClass: .compact, preferredColumn: .sidebar) == .sidebar)
		#expect(ReaderCompactArticlePresentation.columnWithoutHome(horizontalSizeClass: nil, preferredColumn: .sidebar) == .sidebar)
	}

	private func story(_ id: String, feed: String = "feed/1", at date: Date = Date(), isRead: Bool = false) -> Recommendation {
		Recommendation(
			id: id, readerId: id, feedKey: feed, source: feed, title: id, html: "<p>Story</p>", text: nil,
			originalURL: nil, receivedAt: date, isRead: isRead, isStarred: false,
			score: 0, confidence: 0, sampleCount: 0, explanation: "", learningState: "",
		)
	}
}
