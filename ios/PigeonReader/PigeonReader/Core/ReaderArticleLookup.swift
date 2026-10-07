import Foundation

/// Matches the first row sharing either normalized identity, without treating
/// overlapping aliases as a transitive equivalence relation.
nonisolated struct ReaderArticleLookup {
	private var firstIndicesByAlias: [String: Int] = [:]

	init(_ articles: [Recommendation]) {
		for (index, article) in articles.enumerated() {
			for alias in ReaderArticleIdentity.aliases(id: article.id, readerID: article.readerId)
				where firstIndicesByAlias[alias] == nil {
				firstIndicesByAlias[alias] = index
			}
		}
	}

	func firstIndex(matching article: Recommendation) -> Int? {
		ReaderArticleIdentity.aliases(id: article.id, readerID: article.readerId)
			.compactMap { firstIndicesByAlias[$0] }
			.min()
	}
}
