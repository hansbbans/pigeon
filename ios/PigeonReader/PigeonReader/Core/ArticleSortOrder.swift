import Foundation

nonisolated enum ArticleSortOrder: String, CaseIterable, Identifiable, Sendable {
	case recommended
	case newest
	case oldest
	case score
	/// Read It Later only. Unknown lengths sort last.
	case shortest
	case longest

	var id: Self { self }

	var title: String {
		switch self {
		case .recommended: "Recommended"
		case .newest: "Newest to Oldest"
		case .oldest: "Oldest to Newest"
		case .score: "Score"
		case .shortest: "Shortest First"
		case .longest: "Longest First"
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
		}
	}

	static func defaultOrder(for section: ReaderSection) -> Self {
		section == .forYou ? .recommended : .newest
	}

	func sorted(_ articles: [Recommendation]) -> [Recommendation] {
		switch self {
		case .recommended:
			return articles
		case .shortest, .longest:
			// Compute each length once, not per comparison.
			return articles
				.map { (minutes: SavedLength.minutes(for: $0), article: $0) }
				.sorted { SavedLength.areInIncreasingOrder($0, $1, longestFirst: self == .longest) }
				.map(\.article)
		case .newest, .oldest, .score:
			return articles.sorted(by: areInIncreasingOrder)
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

	/// The comparator behind `sorted`. Recommended has no key of its own, so it
	/// never orders one story before another.
	func areInIncreasingOrder(_ left: Recommendation, _ right: Recommendation) -> Bool {
		guard self != .recommended else { return false }
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
}
