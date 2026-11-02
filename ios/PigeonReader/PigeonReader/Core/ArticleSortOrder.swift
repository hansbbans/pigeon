import Foundation

nonisolated enum ArticleSortOrder: String, CaseIterable, Identifiable, Sendable {
	case recommended
	case newest
	case oldest
	case score

	var id: Self { self }

	var title: String {
		switch self {
		case .recommended: "Recommended"
		case .newest: "Newest to Oldest"
		case .oldest: "Oldest to Newest"
		case .score: "Score"
		}
	}

	var systemImage: String {
		switch self {
		case .recommended: "sparkles"
		case .newest: "calendar.badge.clock"
		case .oldest: "calendar"
		case .score: "chart.bar.fill"
		}
	}

	static func defaultOrder(for section: ReaderSection) -> Self {
		section == .forYou ? .recommended : .newest
	}

	func sorted(_ articles: [Recommendation]) -> [Recommendation] {
		guard self != .recommended else {
			return articles
		}
		return articles.sorted(by: areInIncreasingOrder)
	}

	/// The comparator behind `sorted`. Recommended has no key of its own, so it
	/// never orders one story before another.
	func areInIncreasingOrder(_ left: Recommendation, _ right: Recommendation) -> Bool {
		guard self != .recommended else { return false }
		if self == .score, left.score != right.score {
			return left.score > right.score
		}
		if left.receivedAt != right.receivedAt {
			return self == .oldest ? left.receivedAt < right.receivedAt : left.receivedAt > right.receivedAt
		}
		return left.id < right.id
	}
}
