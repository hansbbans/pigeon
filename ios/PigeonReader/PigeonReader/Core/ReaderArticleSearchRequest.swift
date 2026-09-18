import Foundation

nonisolated struct ReaderArticleSearchRequest: Equatable, Sendable {
	let accountID: String?
	let collectionID: String
	let scope: ReaderSearchScope
	let query: String
	var attempt = 0

	var isActive: Bool { query.isEmpty == false }

	func sharesResultContext(with other: Self) -> Bool {
		accountID == other.accountID && collectionID == other.collectionID && scope == other.scope
	}
}
