import Foundation

/// Sorts and canonicalizes a cached library off the main actor before the
/// model applies it. Newsletter bodies stay on the `Recommendation` values, so
/// this work must not run during a scene-phase update.
nonisolated enum CachedLibrarySnapshotPreparation {
	struct Ordering: Equatable, Sendable {
		var sortOrders: [String: ArticleSortOrder]
		var canonicalOrder: [String: [String]]
	}

	typealias Prepare = @Sendable ([String: [Recommendation]], Ordering) async -> [String: [Recommendation]]

	static func prepare(_ articles: [String: [Recommendation]], ordering: Ordering) async -> [String: [Recommendation]] {
		await Task.detached(priority: .utility) {
			sortedArticlesByCollection(articles, sortOrders: ordering.sortOrders, canonicalOrder: ordering.canonicalOrder)
		}.value
	}

	static func sortedArticlesByCollection(
		_ articlesByCollection: [String: [Recommendation]],
		sortOrders: [String: ArticleSortOrder],
		canonicalOrder: [String: [String]],
	) -> [String: [Recommendation]] {
		articlesByCollection.reduce(into: [:]) { result, pair in
			let order = sortOrders[pair.key]
				?? ReaderSection(rawValue: pair.key).map(ArticleSortOrder.defaultOrder)
				?? .newest
			result[pair.key] = order.sorted(
				canonicalArticles(pair.value, canonicalIDs: canonicalOrder[pair.key]),
			)
		}
	}

	static func canonicalArticles(
		_ fallback: [Recommendation],
		canonicalIDs: [String]?,
	) -> [Recommendation] {
		guard let canonicalIDs, canonicalIDs.isEmpty == false else {
			return fallback
		}
		var articlesByID: [String: Recommendation] = [:]
		for article in fallback {
			for alias in ReaderArticleIdentity.aliases(id: article.id, readerID: article.readerId) {
				articlesByID[alias] = article
			}
		}
		var ordered: [Recommendation] = []
		ordered.reserveCapacity(fallback.count)
		var orderedAliases = Set<String>()
		for id in canonicalIDs {
			if let article = articlesByID[ReaderArticleIdentity.normalized(id)],
				orderedAliases.isDisjoint(with: ReaderArticleIdentity.aliases(id: article.id, readerID: article.readerId)) {
				ordered.append(article)
				orderedAliases.formUnion(ReaderArticleIdentity.aliases(id: article.id, readerID: article.readerId))
			}
		}
		ordered.append(contentsOf: fallback.filter {
			orderedAliases.isDisjoint(with: ReaderArticleIdentity.aliases(id: $0.id, readerID: $0.readerId))
		})
		return ordered
	}
}
