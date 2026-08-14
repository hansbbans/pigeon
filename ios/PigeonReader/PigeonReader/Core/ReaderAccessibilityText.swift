import Foundation

enum ReaderAccessibilityText {
	static func sortStories(for collectionTitle: String) -> String {
		"Sort \(collectionTitle) stories"
	}

	static let unreadCollectionsOnly = "Show collections with unread stories only"
	static let unreadStoriesOnly = "Show unread stories only"
}
