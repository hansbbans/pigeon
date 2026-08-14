enum ReaderAccessibilityText {
	static func sortStories(for collectionTitle: String) -> String {
		"Sort \(collectionTitle) stories"
	}

	static func filterStories(for collectionTitle: String) -> String {
		"Filter \(collectionTitle) stories"
	}

	static let filterCollections = "Filter collections"
	static let filterStoriesHint = "Choose all, unread, or read stories in this collection."
	static let filterCollectionsHint = "Choose all collections or only collections with unread stories."
}
