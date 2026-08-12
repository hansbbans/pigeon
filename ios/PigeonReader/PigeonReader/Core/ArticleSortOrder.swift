import Foundation

enum ArticleSortOrder: String, CaseIterable, Identifiable, Sendable {
	case newest
	case score

	var id: Self { self }

	var title: String {
		switch self {
		case .newest: "Newest to Oldest"
		case .score: "Score"
		}
	}

	var systemImage: String {
		switch self {
		case .newest: "calendar.badge.clock"
		case .score: "chart.bar.fill"
		}
	}

	static func defaultOrder(for section: ReaderSection) -> Self {
		section == .forYou ? .score : .newest
	}

	func sorted(_ articles: [Recommendation]) -> [Recommendation] {
		articles.sorted { left, right in
			if self == .score, left.score != right.score {
				return left.score > right.score
			}
			if left.receivedAt != right.receivedAt {
				return left.receivedAt > right.receivedAt
			}
			return left.id < right.id
		}
	}
}
