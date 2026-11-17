import Foundation

nonisolated enum ArticleSortOrder: String, CaseIterable, Identifiable, Sendable {
	case recommended
	case newest
	case oldest
	case score
	/// Read It Later only. Unknown lengths sort last.
	case shortest
	case longest
	/// Folders only, and their default: feeds by title, newest first in each.
	case byFeed

	var id: Self { self }

	var title: String {
		switch self {
		case .recommended: "Recommended"
		case .newest: "Newest to Oldest"
		case .oldest: "Oldest to Newest"
		case .score: "Score"
		case .shortest: "Shortest First"
		case .longest: "Longest First"
		case .byFeed: "By Feed"
		}
	}

	var systemImage: String {
		switch self {
		case .recommended: "sparkles"
		case .newest: "calendar.badge.clock"
		case .oldest: "calendar"
		case .score: "chart.bar.fill"
		case .shortest: "hourglass.bottomhalf.filled"
		case .longest: "hourglass.tophalf.filled"
		case .byFeed: "rectangle.stack"
		}
	}

	static func defaultOrder(for section: ReaderSection) -> Self {
		section == .forYou ? .recommended : .newest
	}

	/// Folders open grouped by feed; everything else keeps its section default.
	static func defaultOrder(forCollectionID collectionID: String) -> Self {
		if ReaderNavigationItem.isFolderID(collectionID) {
			return .byFeed
		}
		return ReaderSection(rawValue: collectionID).map(defaultOrder(for:)) ?? .newest
	}

	/// The order a collection shows, given its saved choice. By Feed saved for
	/// anything but a folder (a newer build, a renamed ID) falls back to the
	/// default; other saved orders keep their existing meaning.
	static func resolved(_ saved: Self?, forCollectionID collectionID: String) -> Self {
		guard let saved, saved != .byFeed || ReaderNavigationItem.isFolderID(collectionID) else {
			return defaultOrder(forCollectionID: collectionID)
		}
		return saved
	}

	/// `feeds` resolves each story's feed for By Feed; other orders ignore it.
	func sorted(_ articles: [Recommendation], feeds: ArticleFeedDirectory = .empty) -> [Recommendation] {
		switch self {
		case .recommended:
			return articles
		case .shortest, .longest:
			// Compute each length once, not per comparison.
			return articles
				.map { (minutes: SavedLength.minutes(for: $0), article: $0) }
				.sorted { SavedLength.areInIncreasingOrder($0, $1, longestFirst: self == .longest) }
				.map(\.article)
		case .byFeed:
			// Resolve each feed once, not per comparison.
			return articles
				.map { (feed: feeds.feed(for: $0), article: $0) }
				.sorted { Self.feedOrder($0.feed, $0.article, before: $1.feed, $1.article) }
				.map(\.article)
		case .newest, .oldest, .score:
			return articles.sorted { areInIncreasingOrder($0, $1) }
		}
	}

	/// Orders offered for a collection: length only in Read It Later, which in
	/// turn has no ranking.
	static func available(for section: ReaderSection?) -> [Self] {
		switch section {
		case .saved: [.newest, .oldest, .shortest, .longest]
		case .forYou: [.recommended, .newest, .oldest, .score]
		default: [.newest, .oldest, .score]
		}
	}

	/// Orders offered for a collection ID: By Feed, first, only in folders.
	static func available(forCollectionID collectionID: String) -> [Self] {
		if ReaderNavigationItem.isFolderID(collectionID) {
			return [.byFeed, .newest, .oldest, .score]
		}
		return available(for: ReaderSection(rawValue: collectionID))
	}

	/// The comparator behind `sorted`. Recommended has no key of its own, so it
	/// never orders one story before another.
	func areInIncreasingOrder(
		_ left: Recommendation,
		_ right: Recommendation,
		feeds: ArticleFeedDirectory = .empty,
	) -> Bool {
		guard self != .recommended else { return false }
		if self == .byFeed {
			return Self.feedOrder(feeds.feed(for: left), left, before: feeds.feed(for: right), right)
		}
		if self == .shortest || self == .longest {
			return SavedLength.areInIncreasingOrder(
				(SavedLength.minutes(for: left), left),
				(SavedLength.minutes(for: right), right),
				longestFirst: self == .longest,
			)
		}
		if self == .score, left.score != right.score {
			return left.score > right.score
		}
		if left.receivedAt != right.receivedAt {
			return self == .oldest ? left.receivedAt < right.receivedAt : left.receivedAt > right.receivedAt
		}
		return left.id < right.id
	}

	/// Feeds by title ignoring case (numbers by value, like the sidebar), then
	/// by feed ID so equal titles stay separate groups; within a feed, Newest.
	private static func feedOrder(
		_ leftFeed: ArticleFeedDirectory.Feed,
		_ left: Recommendation,
		before rightFeed: ArticleFeedDirectory.Feed,
		_ right: Recommendation,
	) -> Bool {
		if leftFeed.id != rightFeed.id {
			let titles = leftFeed.title.compare(
				rightFeed.title,
				options: [.caseInsensitive, .numeric, .widthInsensitive],
				locale: .current,
			)
			if titles != .orderedSame {
				return titles == .orderedAscending
			}
			return leftFeed.id < rightFeed.id
		}
		return ArticleSortOrder.newest.areInIncreasingOrder(left, right)
	}
}
