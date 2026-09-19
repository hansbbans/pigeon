import Foundation

nonisolated struct ReaderArticleUndo: Identifiable, Sendable {
	let id = UUID()
	let article: Recommendation
	let field: Field
	let previousValue: Bool
	let appliedValue: Bool
	let accountID: String

	nonisolated enum Field: Sendable {
		case read
		case starred
	}

	var message: String {
		switch field {
		case .read: appliedValue ? "Marked read" : "Marked unread"
		case .starred: appliedValue ? "Story starred" : "Star removed"
		}
	}
}
