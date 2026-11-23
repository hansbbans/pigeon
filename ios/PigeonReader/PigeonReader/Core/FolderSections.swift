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
			/// Single-feed day sections. A feed's Today is not the folder's
			/// Today card: it shows one source, and the reading log counts it
			/// with the feed's other days.
			case feedToday
			case yesterday
			case earlier

			/// The reading log's `row` for a story this card shows first.
			var readingLogRow: String {
				switch self {
				case .today: "card-today"
				case .lastSevenDays: "card-last-7-days"
				case .feed, .older: "card-feed"
				case .feedToday, .yesterday, .earlier: "card-day"
				}
			}

			/// The reading log's `section` for a story this Reeder list section
			/// shows first: the web app's section names.
			var readingLogSection: String {
				switch self {
				case .today: "today"
				case .lastSevenDays: "last-7-days"
				case .feed, .older: "feed"
				case .feedToday, .yesterday, .earlier: "day"
				}
			}
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

		/// A section showing its first `limit` stories until it is expanded;
		/// nil when it has none.
		static func collapsed(id: String, kind: Kind, title: String, feed: ArticleFeedDirectory.Feed? = nil,
			articles: [Recommendation], limit: Int, expanded: Set<String>) -> Self? {
			guard articles.isEmpty == false else { return nil }
			let shown = expanded.contains(id) ? articles : Array(articles.prefix(limit))
			return Self(id: id, kind: kind, title: title, feed: feed, articles: shown,
				hiddenCount: articles.count - shown.count)
		}
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
	/// Each shown story once, in the order the cards draw them (at its first
	/// appearance, nothing behind "N more"): what above and below mean.
	let renderedArticles: [Recommendation]
	let uniqueArticleIDs: [String]
	/// The reading log's `row` for each story: the card it first appears in.
	let readingLogRows: [String: String]
	/// The section each story first appears in, by id: where the Reeder list
	/// puts its scroll anchor, and the reading log's `section`.
	let firstSectionIDs: [String: String]
	/// Every story as drawn, a story shown twice included twice. Above and
	/// below are taken from the copy a menu was opened on.
	let renderedCopies: [Recommendation]
	/// Each section's stories' places in `renderedCopies`.
	private let copyRanges: [String: Range<Int>]

	/// Everything derived is worked out here, once per build, so a page that
	/// reads it on every body pass does not repeat the work.
	init(sections: [Section]) {
		self.sections = sections
		var seen = Set<String>()
		var rows: [String: String] = [:]
		var firstSections: [String: String] = [:]
		var rendered: [Recommendation] = []
		var copies: [Recommendation] = []
		var ranges: [String: Range<Int>] = [:]
		for section in sections {
			ranges[section.id] = copies.count..<(copies.count + section.articles.count)
			copies.append(contentsOf: section.articles)
			for article in section.articles where seen.insert(article.id).inserted {
				rendered.append(article)
				rows[article.id] = section.kind.readingLogRow
				firstSections[article.id] = section.id
			}
		}
		renderedArticles = rendered
		uniqueArticleIDs = rendered.map(\.id)
		readingLogRows = rows
		firstSectionIDs = firstSections
		renderedCopies = copies
		copyRanges = ranges
	}

	/// The place in `renderedCopies` of the story at `index` in a section.
	func copyIndex(of index: Int, inSection id: String) -> Int? {
		guard let range = copyRanges[id], index >= 0, index < range.count else { return nil }
		return range.lowerBound + index
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
		let week = ReaderLocalDayBounds.lastSevenDays(endingWith: now, calendar: calendar)
		var sections: [Section] = []

		func append(_ id: String, _ kind: Section.Kind, _ title: String, feed: ArticleFeedDirectory.Feed? = nil,
			articles: [Recommendation], limit: Int) {
			if let section = Section.collapsed(id: id, kind: kind, title: title, feed: feed,
				articles: articles, limit: limit, expanded: expanded) {
				sections.append(section)
			}
		}

		// A story dated after today (a skewed clock) is Today, as in a single
		// feed's cards, rather than only in its feed's card.
		append(todayID, .today, "Today", articles: stories.filter { $0.receivedAt >= today.start }, limit: todayLimit)
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

/// A single feed's stories by day (Today, Yesterday, Earlier), newest
/// first: day cards in Cards, day labels in the Reeder list.
nonisolated enum FeedDaySections {
	static let dayLimit = 5

	/// Every day shows `limit` before "N more", Earlier included, so a long
	/// feed is a short page of cards. The Reeder list passes no limit: there
	/// the days only label a list that pages on as it scrolls. A story dated
	/// after today (a skewed clock) counts as Today rather than vanishing.
	static func make(
		articles: [Recommendation],
		now: Date,
		calendar: Calendar = .autoupdatingCurrent,
		expanded: Set<String> = [],
		limit: Int = dayLimit,
	) -> FolderSections {
		let stories = FolderSections.newestFirst(articles)
		let todayStart = ReaderLocalDayBounds.localDay(containing: now, calendar: calendar).start
		let yesterdayStart = calendar.date(byAdding: .day, value: -1, to: todayStart) ?? todayStart.addingTimeInterval(-86_400)
		let groups: [(id: String, kind: FolderSections.Section.Kind, title: String, articles: [Recommendation])] = [
			("today", .feedToday, "Today", stories.filter { $0.receivedAt >= todayStart }),
			("yesterday", .yesterday, "Yesterday",
				stories.filter { $0.receivedAt >= yesterdayStart && $0.receivedAt < todayStart }),
			("earlier", .earlier, "Earlier", stories.filter { $0.receivedAt < yesterdayStart }),
		]
		return FolderSections(sections: groups.compactMap { group in
			FolderSections.Section.collapsed(id: group.id, kind: group.kind, title: group.title,
				articles: group.articles, limit: limit, expanded: expanded)
		})
	}
}
