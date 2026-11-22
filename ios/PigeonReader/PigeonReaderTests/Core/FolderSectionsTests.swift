import Foundation
import Testing
@testable import PigeonReader

/// Folder sections, with the boundary instants and the DST week the web
/// helpers are tested with (America/New_York; clocks went back on 2026-11-01).
struct FolderSectionsTests {
	private let calendar: Calendar = {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = TimeZone(identifier: "America/New_York")!
		return calendar
	}()

	private var now: Date { local(2026, 11, 3, 12) }
	private var todayStart: Date { local(2026, 11, 3) }
	private var weekStart: Date { local(2026, 10, 28) }

	// MARK: Day windows

	@Test func localDaysCoverSixDaysBackToNextMidnightAcrossDST() {
		let bounds = ReaderLocalDayBounds.localDays(7, endingWith: now, calendar: calendar)

		#expect(bounds.start == local(2026, 10, 28))
		#expect(bounds.end == local(2026, 11, 4))
		// Calendar days, not 7 × 86 400 s: the week holds the extra DST hour.
		#expect(bounds.end.timeIntervalSince(bounds.start) == 7 * 86_400 + 3_600)
		#expect(ReaderLocalDayBounds.localDays(1, endingWith: now, calendar: calendar)
			== ReaderLocalDayBounds.localDay(containing: now, calendar: calendar))
	}

	// MARK: Folder sections

	@Test func sectionsGoTodayThenLastSevenDaysThenFeedsByNewestThenOlder() {
		let articles = [
			story("week-start", feed: "feed/2", source: "Two", at: weekStart),
			story("yesterday-late", feed: "feed/1", source: "One", at: todayStart.addingTimeInterval(-1)),
			story("midnight", feed: "feed/1", source: "One", at: todayStart),
			story("too-old", feed: "feed/3", source: "Three", at: weekStart.addingTimeInterval(-1)),
		]

		let sections = FolderSections.make(articles: articles, feeds: .empty, now: now, calendar: calendar)

		#expect(sections.sections.map(\.id) == ["today", "last-7-days", "feed:feed/1", "feed:feed/2", "older", "feed:feed/3"])
		#expect(sections.sections.map(\.kind) == [.today, .lastSevenDays, .feed, .feed, .older, .feed])
		#expect(sections.sections.map(\.title) == ["Today", "Last 7 Days", "One", "Two", "Older", "Three"])
		#expect(ids(sections, "today") == ["midnight"])
		#expect(ids(sections, "last-7-days") == ["yesterday-late", "week-start"])
		#expect(ids(sections, "feed:feed/1") == ["midnight", "yesterday-late"])
		#expect(ids(sections, "older") == [])
		#expect(sections.sections.first { $0.id == "older" }?.feed == nil)
		#expect(sections.sections.first { $0.id == "feed:feed/3" }?.feed?.title == "Three")
	}

	@Test func lastSevenDaysStartsOnCalendarDaysAcrossDST() {
		// 00:30 EDT on Oct 28 is inside the week by calendar days but would be
		// outside it if the window were 7 × 86 400 s back from next midnight.
		let early = story("early", feed: "feed/1", source: "One", at: weekStart.addingTimeInterval(1_800))

		let sections = FolderSections.make(articles: [early], feeds: .empty, now: now, calendar: calendar)

		#expect(sections.sections.map(\.id) == ["last-7-days", "feed:feed/1"])
	}

	@Test func emptySectionsAreLeftOut() {
		let sections = FolderSections.make(
			articles: [story("old", feed: "feed/1", source: "One", at: local(2026, 10, 1))],
			feeds: .empty, now: now, calendar: calendar,
		)

		#expect(sections.sections.map(\.id) == ["older", "feed:feed/1"])
		#expect(FolderSections.make(articles: [], feeds: .empty, now: now, calendar: calendar).sections.isEmpty)
	}

	@Test func limitsHideTheRestBehindACountAndExpandingShowsEveryLoadedStory() {
		let articles = (0..<8).map { index in
			story("s\(index)", feed: "feed/1", source: "One", at: todayStart.addingTimeInterval(Double(index) * 60))
		}

		let collapsed = FolderSections.make(articles: articles, feeds: .empty, now: now, calendar: calendar)

		#expect(FolderSections.todayLimit == 5)
		#expect(FolderSections.lastSevenDaysLimit == 5)
		#expect(FolderSections.feedLimit == 3)
		#expect(ids(collapsed, "today") == ["s7", "s6", "s5", "s4", "s3"])
		#expect(collapsed.sections.first { $0.id == "today" }?.hiddenCount == 3)
		#expect(ids(collapsed, "feed:feed/1") == ["s7", "s6", "s5"])
		#expect(collapsed.sections.first { $0.id == "feed:feed/1" }?.hiddenCount == 5)

		let expanded = FolderSections.make(
			articles: articles, feeds: .empty, now: now, calendar: calendar, expanded: ["feed:feed/1"],
		)

		#expect(ids(expanded, "today") == ["s7", "s6", "s5", "s4", "s3"])
		#expect(ids(expanded, "feed:feed/1") == ["s7", "s6", "s5", "s4", "s3", "s2", "s1", "s0"])
		#expect(expanded.sections.first { $0.id == "feed:feed/1" }?.hiddenCount == 0)
	}

	@Test func feedsTieOnNewestStoryByTitleThenID() {
		let at = todayStart.addingTimeInterval(600)
		let articles = [
			story("b2", feed: "feed/9", source: "Beta", at: at),
			story("a", feed: "feed/5", source: "alpha", at: at),
			story("b1", feed: "feed/2", source: "Beta", at: at),
		]

		let sections = FolderSections.make(articles: articles, feeds: .empty, now: now, calendar: calendar)

		#expect(sections.sections.filter { $0.kind == .feed }.map(\.id) == ["feed:feed/5", "feed:feed/2", "feed:feed/9"])
	}

	@Test func storiesResolveThroughTheDirectoryAndUnknownFeedsUseTheirOwnKeyAndSource() {
		let directory = ArticleFeedDirectory(navigationItems: [
			ReaderNavigationItem(
				id: "feed/7::user/-/label/Tech", title: "Stratechery", streamID: "feed/7", kind: .feed, unreadCount: 0,
				parentID: "user/-/label/Tech", feedKey: "stratechery", iconURL: URL(string: "https://stratechery.com/favicon.ico"),
				smartSection: nil,
			),
		])
		let articles = [
			story("stream", feed: "feed/7", source: "Old Name", at: todayStart.addingTimeInterval(60)),
			story("sync", feed: "stratechery", source: "Stratechery", at: todayStart.addingTimeInterval(120)),
			story("stray", feed: "unknown-key", source: "Stray Newsletter", at: todayStart.addingTimeInterval(30)),
		]

		let sections = FolderSections.make(articles: articles, feeds: directory, now: now, calendar: calendar)
		let feedSections = sections.sections.filter { $0.kind == .feed }

		#expect(feedSections.map(\.id) == ["feed:feed/7", "feed:unknown-key"])
		#expect(feedSections.map(\.title) == ["Stratechery", "Stray Newsletter"])
		#expect(feedSections[0].feed?.iconURL == URL(string: "https://stratechery.com/favicon.ico"))
		#expect(feedSections[0].articles.map(\.id) == ["sync", "stream"])
	}

	@Test func uniqueIDsFollowFirstAppearanceAndSkipHiddenStories() {
		let articles = [
			story("f2-today", feed: "feed/2", source: "Two", at: todayStart.addingTimeInterval(60)),
			story("f1-today", feed: "feed/1", source: "One", at: todayStart.addingTimeInterval(120)),
			story("f1-week", feed: "feed/1", source: "One", at: todayStart.addingTimeInterval(-3_600)),
			story("f1-older-1", feed: "feed/1", source: "One", at: local(2026, 10, 1)),
			story("f1-older-2", feed: "feed/1", source: "One", at: local(2026, 9, 1)),
			// A duplicate from a second page counts once.
			story("f1-today", feed: "feed/1", source: "One", at: todayStart.addingTimeInterval(120)),
		]

		let sections = FolderSections.make(articles: articles, feeds: .empty, now: now, calendar: calendar)

		#expect(ids(sections, "today") == ["f1-today", "f2-today"])
		#expect(ids(sections, "feed:feed/1") == ["f1-today", "f1-week", "f1-older-1"])
		#expect(sections.uniqueArticleIDs == ["f1-today", "f2-today", "f1-week", "f1-older-1"])
	}

	@Test func readStoriesStayInPlace() {
		var read = story("read", feed: "feed/1", source: "One", at: todayStart.addingTimeInterval(120))
		read.isRead = true
		let unread = story("unread", feed: "feed/1", source: "One", at: todayStart.addingTimeInterval(60))

		let sections = FolderSections.make(articles: [unread, read], feeds: .empty, now: now, calendar: calendar)

		#expect(ids(sections, "today") == ["read", "unread"])
		#expect(sections.sections.first { $0.id == "today" }?.articles.first?.isRead == true)
	}

	// MARK: Single feed

	@Test func aFeedGoesTodayYesterdayThenEarlier() {
		let articles = [
			story("earlier", feed: "feed/1", source: "One", at: local(2026, 10, 20)),
			story("yesterday", feed: "feed/1", source: "One", at: local(2026, 11, 2, 9)),
			story("yesterday-start", feed: "feed/1", source: "One", at: local(2026, 11, 2)),
			story("today", feed: "feed/1", source: "One", at: todayStart),
			story("day-before", feed: "feed/1", source: "One", at: local(2026, 11, 2).addingTimeInterval(-1)),
		]

		let sections = FeedDaySections.make(articles: articles, now: now, calendar: calendar)

		#expect(sections.sections.map(\.id) == ["today", "yesterday", "earlier"])
		#expect(sections.sections.map(\.kind) == [.today, .yesterday, .earlier])
		#expect(sections.sections.map(\.title) == ["Today", "Yesterday", "Earlier"])
		#expect(ids(sections, "today") == ["today"])
		#expect(ids(sections, "yesterday") == ["yesterday", "yesterday-start"])
		#expect(ids(sections, "earlier") == ["day-before", "earlier"])
		#expect(sections.uniqueArticleIDs == ["today", "yesterday", "yesterday-start", "day-before", "earlier"])
	}

	@Test func aFeedLimitsEveryDayIncludingItsEarlierTail() {
		let today = (0..<7).map { story("t\($0)", feed: "feed/1", source: "One", at: todayStart.addingTimeInterval(Double($0) * 60)) }
		let earlier = (0..<9).map { story("e\($0)", feed: "feed/1", source: "One", at: local(2026, 10, 1).addingTimeInterval(Double($0) * 60)) }
		// A story dated after today's end (a skewed clock) still shows, in Today.
		let future = story("future", feed: "feed/1", source: "One", at: local(2026, 11, 5))

		let collapsed = FeedDaySections.make(articles: today + earlier + [future], now: now, calendar: calendar)

		#expect(ids(collapsed, "today").first == "future")
		#expect(collapsed.sections.first { $0.id == "today" }?.hiddenCount == 3)
		// Earlier is capped like the other days, so a long feed stays a short page.
		#expect(ids(collapsed, "earlier").count == FeedDaySections.dayLimit)
		#expect(collapsed.sections.first { $0.id == "earlier" }?.hiddenCount == 4)

		let expanded = FeedDaySections.make(
			articles: today + earlier + [future], now: now, calendar: calendar, expanded: ["today", "earlier"],
		)
		#expect(ids(expanded, "today").count == 8)
		#expect(ids(expanded, "earlier").count == 9)
	}

	/// A story dated after today (a skewed clock) is Today in a folder too,
	/// as it is in a single feed, rather than only in its feed's card.
	@Test func aFutureStoryIsTodayInAFolder() {
		let future = story("future", feed: "feed/1", source: "One", at: local(2026, 11, 5))
		let today = story("today", feed: "feed/2", source: "Two", at: todayStart.addingTimeInterval(60))

		let sections = FolderSections.make(articles: [today, future], feeds: .empty, now: now, calendar: calendar)

		#expect(ids(sections, FolderSections.todayID) == ["future", "today"])
		#expect(ids(sections, FolderSections.lastSevenDaysID).isEmpty)
	}

	/// The Cards page is rebuilt from the loaded stories, so a big folder must
	/// still build in a fraction of a frame budget's worth of seconds.
	@Test func aHundredFeedsAndAThousandStoriesBuildQuickly() {
		let directory = ArticleFeedDirectory(navigationItems: (0..<100).map { index in
			ReaderNavigationItem(
				id: "feed/\(index)", title: "Feed \(index)", streamID: "feed/\(index)", kind: .feed, unreadCount: 10,
				parentID: nil, feedKey: "feed-\(index)", iconURL: nil, smartSection: nil,
			)
		})
		let articles = (0..<1_000).map { index in
			story("s\(index)", feed: "feed-\(index % 100)", source: "Feed \(index % 100)",
				at: now.addingTimeInterval(-Double(index) * 1_800))
		}
		let clock = ContinuousClock()

		var sections: FolderSections?
		let elapsed = clock.measure {
			for _ in 0..<10 {
				sections = FolderSections.make(articles: articles, feeds: directory, now: now, calendar: calendar)
			}
		}

		#expect(sections?.sections.filter { $0.kind == .feed }.count == 100)
		// Every story Today and Last 7 Days show is also among its feed's newest three.
		#expect(sections?.uniqueArticleIDs.count == 300)
		// Ten builds; one is well under 50 ms.
		#expect(elapsed < .milliseconds(500), "10 builds took \(elapsed)")
	}

	// MARK: Helpers

	private func ids(_ sections: FolderSections, _ id: String) -> [String] {
		sections.sections.first { $0.id == id }?.articles.map(\.id) ?? []
	}

	private func local(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0) -> Date {
		calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
	}

	private func story(_ id: String, feed: String, source: String, at date: Date) -> Recommendation {
		Recommendation(
			id: id, readerId: id, feedKey: feed, source: source, title: id, html: "<p>Story</p>", text: nil,
			originalURL: nil, receivedAt: date, isRead: false, isStarred: false,
			score: 0, confidence: 0, sampleCount: 0, explanation: "", learningState: "",
		)
	}
}
