import Foundation

/// A folder's loaded stories as the Cards look shows them: Today, Last 7 Days,
/// then one section per feed ordered by its newest story, with feeds that have
/// nothing from the last 7 days after an "Older" header. The rules match the
/// web app's `buildFolderSections`; all days are local calendar days.
///
/// A story can appear twice (in Today or Last 7 Days and in its feed's
/// section). `uniqueArticleIDs` lists each shown story once, at its first
/// appearance, for impressions and selection order.
nonisolated struct FolderSections: Equatable, Sendable {
	nonisolated struct Section: Equatable, Identifiable, Sendable {
		enum Kind: Equatable, Sendable {
			case today
			case lastSevenDays
			case feed
			/// A header with no stories; the feed sections after it are older
			/// than the last 7 days.
			case older
			/// Single-feed day sections.
			case yesterday
			case earlier
		}

		let id: String
		let kind: Kind
		let title: String
		/// Set for feed sections.
		let feed: ArticleFeedDirectory.Feed?
		/// The stories shown, newest first.
		let articles: [Recommendation]
		/// Loaded stories left out until the section is expanded ("N more").
		let hiddenCount: Int
	}

	static let todayLimit = 5
	static let lastSevenDaysLimit = 5
	static let feedLimit = 3

	static let todayID = "today"
	static let lastSevenDaysID = "last-7-days"
	static let olderID = "older"

	static func feedSectionID(_ feed: ArticleFeedDirectory.Feed) -> String {
		"feed:\(feed.id)"
	}

	let sections: [Section]
	let uniqueArticleIDs: [String]

	init(sections: [Section]) {
		self.sections = sections
		var seen = Set<String>()
		uniqueArticleIDs = sections.flatMap(\.articles).map(\.id).filter { seen.insert($0).inserted }
	}

	/// Each shown story once, in the order the cards draw them (at its first
	/// appearance, nothing behind "N more"): what above and below mean.
	var renderedArticles: [Recommendation] {
		var seen = Set<String>()
		return sections.flatMap(\.articles).filter { seen.insert($0.id).inserted }
	}

	/// `expanded` holds the ids of sections shown in full.
	static func make(
		articles: [Recommendation],
		feeds: ArticleFeedDirectory,
		now: Date,
		calendar: Calendar = .autoupdatingCurrent,
		expanded: Set<String> = [],
	) -> Self {
		let stories = newestFirst(articles)
		let today = ReaderLocalDayBounds.localDay(containing: now, calendar: calendar)
		let week = ReaderLocalDayBounds.localDays(7, endingWith: now, calendar: calendar)
		var sections: [Section] = []

		func append(_ id: String, _ kind: Section.Kind, _ title: String, feed: ArticleFeedDirectory.Feed? = nil,
			articles: [Recommendation], limit: Int?) {
			guard articles.isEmpty == false else { return }
			let shown = expanded.contains(id) || limit == nil ? articles : Array(articles.prefix(limit ?? 0))
			sections.append(Section(id: id, kind: kind, title: title, feed: feed, articles: shown,
				hiddenCount: articles.count - shown.count))
		}

		append(todayID, .today, "Today", articles: stories.filter { today.contains($0.receivedAt) }, limit: todayLimit)
		append(lastSevenDaysID, .lastSevenDays, "Last 7 Days",
			articles: stories.filter { $0.receivedAt >= week.start && $0.receivedAt < today.start },
			limit: lastSevenDaysLimit)

		// Stories are newest first, so each feed's first story is its newest
		// and feeds come out in order of first appearance, ties aside.
		var feedOrder: [ArticleFeedDirectory.Feed] = []
		var storiesByFeed: [String: [Recommendation]] = [:]
		for story in stories {
			let feed = feeds.feed(for: story)
			if storiesByFeed[feed.id] == nil { feedOrder.append(feed) }
			storiesByFeed[feed.id, default: []].append(story)
		}
		let newestByFeed = storiesByFeed.compactMapValues { $0.first?.receivedAt }
		feedOrder.sort { left, right in
			let leftNewest = newestByFeed[left.id] ?? .distantPast
			let rightNewest = newestByFeed[right.id] ?? .distantPast
			if leftNewest != rightNewest { return leftNewest > rightNewest }
			let titles = left.title.localizedStandardCompare(right.title)
			if titles != .orderedSame { return titles == .orderedAscending }
			return left.id < right.id
		}

		var hasOlderHeader = false
		for feed in feedOrder {
			if hasOlderHeader == false, (newestByFeed[feed.id] ?? .distantPast) < week.start {
				hasOlderHeader = true
				sections.append(Section(id: olderID, kind: .older, title: "Older", feed: nil, articles: [], hiddenCount: 0))
			}
			append(feedSectionID(feed), .feed, feed.title, feed: feed, articles: storiesByFeed[feed.id] ?? [], limit: feedLimit)
		}
		return Self(sections: sections)
	}

	/// Newest first, ties by id (as `ArticleSortOrder.newest`), each story once.
	static func newestFirst(_ articles: [Recommendation]) -> [Recommendation] {
		var seen = Set<String>()
		return articles
			.filter { seen.insert($0.id).inserted }
			.sorted { ArticleSortOrder.newest.areInIncreasingOrder($0, $1) }
	}
}

/// A single feed in the Cards look: its stories by day (Today, Yesterday,
/// Earlier), newest first.
nonisolated enum FeedDaySections {
	static let dayLimit = 5

	/// Today and Yesterday show `dayLimit` before "N more". Earlier is the
	/// feed's paginated tail, so it shows everything loaded. A story dated
	/// after today (a skewed clock) counts as Today rather than vanishing.
	static func make(
		articles: [Recommendation],
		now: Date,
		calendar: Calendar = .autoupdatingCurrent,
		expanded: Set<String> = [],
	) -> FolderSections {
		let stories = FolderSections.newestFirst(articles)
		let todayStart = ReaderLocalDayBounds.localDay(containing: now, calendar: calendar).start
		let yesterdayStart = calendar.date(byAdding: .day, value: -1, to: todayStart) ?? todayStart.addingTimeInterval(-86_400)
		let groups: [(id: String, kind: FolderSections.Section.Kind, title: String, articles: [Recommendation], limit: Int?)] = [
			("today", .today, "Today", stories.filter { $0.receivedAt >= todayStart }, dayLimit),
			("yesterday", .yesterday, "Yesterday",
				stories.filter { $0.receivedAt >= yesterdayStart && $0.receivedAt < todayStart }, dayLimit),
			("earlier", .earlier, "Earlier", stories.filter { $0.receivedAt < yesterdayStart }, nil),
		]
		return FolderSections(sections: groups.compactMap { group in
			guard group.articles.isEmpty == false else { return nil }
			let shown = expanded.contains(group.id) || group.limit == nil
				? group.articles
				: Array(group.articles.prefix(group.limit ?? 0))
			return FolderSections.Section(id: group.id, kind: group.kind, title: group.title, feed: nil,
				articles: shown, hiddenCount: group.articles.count - shown.count)
		})
	}
}
