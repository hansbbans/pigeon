import Foundation

/// Matches the first row sharing either normalized identity, without treating
/// overlapping aliases as a transitive equivalence relation.
nonisolated struct ReaderArticleLookup {
	private var firstIndicesByAlias: [String: Int] = [:]

	init(_ articles: [Recommendation]) {
		firstIndicesByAlias.reserveCapacity(articles.count * 2)
		for (index, article) in articles.enumerated() {
			let id = ReaderArticleIdentity.normalized(article.id)
			if id.isEmpty == false, firstIndicesByAlias[id] == nil {
				firstIndicesByAlias[id] = index
			}
			let readerID = ReaderArticleIdentity.normalized(article.readerId)
			if readerID.isEmpty == false, firstIndicesByAlias[readerID] == nil {
				firstIndicesByAlias[readerID] = index
			}
		}
	}

	/// Looks up both ids directly. This runs once per cached row whenever
	/// stories are merged, so it must not build a set per call.
	func firstIndex(matching article: Recommendation) -> Int? {
		let id = ReaderArticleIdentity.normalized(article.id)
		let readerID = ReaderArticleIdentity.normalized(article.readerId)
		let byID = id.isEmpty ? nil : firstIndicesByAlias[id]
		let byReaderID = readerID.isEmpty ? nil : firstIndicesByAlias[readerID]
		guard let byID else { return byReaderID }
		guard let byReaderID else { return byID }
		return min(byID, byReaderID)
	}
}
