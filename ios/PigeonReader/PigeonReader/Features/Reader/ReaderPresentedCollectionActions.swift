import Foundation

extension ReaderAppModel {
	/// A bounded refresh can replace the cached first page while its previous
	/// rows remain on screen. An explicit action on one of those rows must still
	/// have the full story available to the reader and mutation handlers.
	///
	/// `order` is the order the page draws its stories in (story ids, each
	/// once) when that is not the collection's sort, as in the Cards look; the
	/// reader's next and previous follow it. Nil means the list's own order.
	func retainPresentedArticles(_ presented: [Recommendation], in collection: ReaderNavigationItem, order: [String]? = nil) {
		guard selectedNavigationID == collection.id else { return }
		setPresentedArticleOrder(order.map { ReaderPresentedArticleOrder(collectionID: collection.id, ids: $0) })
		let cached = allArticles(for: collection)
		let known = Set(cached.map(\.id))
		// Rows kept after being read are display-only; writing them back would
		// persist read stories into lists like Unread past the next re-filter.
		let retained = presented.filter { known.contains($0.id) == false && isKeptAfterLeavingFilter($0) == false }
		guard retained.isEmpty == false else { return }
		setArticles(cached + retained, for: collection)
	}
}

/// A feed opened from a folder's card, pushed above the folder (Cards).
struct ReaderCardFeedDestination: Hashable {
	let feedID: String
}

/// A level of the Cards navigation stack above Home.
enum ReaderCardsRoute: Hashable {
	/// The open list (`ReaderAppModel.contentRootCollection`).
	case list
	/// A feed pushed above its folder, by navigation item id.
	case feed(String)
}

/// The order a page draws a collection's stories in when it is not the
/// collection's sort (the Cards look draws cards).
nonisolated struct ReaderPresentedArticleOrder: Equatable, Sendable {
	let collectionID: String
	let ids: [String]
	/// Each id's first place in `ids`, built once: next and previous read the
	/// order on every reader toolbar pass.
	private let ranks: [String: Int]

	init(collectionID: String, ids: [String]) {
		self.collectionID = collectionID
		self.ids = ids
		var ranks: [String: Int] = [:]
		for (rank, id) in ids.enumerated() where ranks[id] == nil {
			ranks[id] = rank
		}
		self.ranks = ranks
	}

	static func == (lhs: Self, rhs: Self) -> Bool {
		lhs.collectionID == rhs.collectionID && lhs.ids == rhs.ids
	}

	/// `articles` in the drawn order; stories the page does not draw (behind
	/// "N more") follow, in their own order.
	func ordering(_ articles: [Recommendation]) -> [Recommendation] {
		var drawn: [(rank: Int, article: Recommendation)] = []
		var rest: [Recommendation] = []
		for article in articles {
			if let rank = ranks[article.id] {
				drawn.append((rank, article))
			} else {
				rest.append(article)
			}
		}
		return drawn.sorted { $0.rank < $1.rank }.map(\.article) + rest
	}
}
