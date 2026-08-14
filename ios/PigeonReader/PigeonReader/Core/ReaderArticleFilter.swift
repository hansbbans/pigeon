import Foundation

enum ReaderArticleFilter: String, CaseIterable, Hashable, Identifiable, Sendable {
	case all
	case unread
	case read

	var id: Self { self }

	var title: String {
		switch self {
		case .all: "All"
		case .unread: "Unread"
		case .read: "Read"
		}
	}

	func filtering(_ articles: [Recommendation]) -> [Recommendation] {
		guard self != .all else {
			return articles
		}
		return articles.filter { article in
			switch self {
			case .all: true
			case .unread: article.isRead == false
			case .read: article.isRead
			}
		}
	}
}
