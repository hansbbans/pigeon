import Foundation

/// Stories that left the open list's read filter because their read state
/// changed while the list was on screen. The list keeps showing them (with read
/// styling) until a deliberate event, such as switching collections, changing
/// the filter or sort, refreshing, or a bulk mark-read, re-filters it.
///
/// Memory only: a relaunch always starts from a freshly filtered list.
nonisolated struct ReaderKeptArticles: Sendable {
	private(set) var collectionID: String?
	private(set) var filter: ReaderArticleFilter?
	/// Retained copies in the order they were kept, with the index each one had
	/// in the displayed list at that moment. The index places a copy that later
	/// leaves the cache when the list order has no sortable key (Recommended).
	private var entries: [Entry] = []
	private var indicesByAlias: [String: Int] = [:]

	private struct Entry: Sendable {
		var article: Recommendation
		let position: Int
	}

	var isEmpty: Bool { entries.isEmpty }

	func applies(to collectionID: String, filter: ReaderArticleFilter) -> Bool {
		entries.isEmpty == false && self.collectionID == collectionID && self.filter == filter
	}

	func contains(_ article: Recommendation) -> Bool {
		index(matching: article) != nil
	}

	func article(withID id: String) -> Recommendation? {
		let alias = ReaderArticleIdentity.normalized(id)
		return indicesByAlias[alias].map { entries[$0].article }
	}

	/// Keeps `article` (already carrying its new read state) in `collectionID`.
	/// Keeping into a different list or filter starts a new set.
	mutating func keep(
		_ article: Recommendation,
		in collectionID: String,
		filter: ReaderArticleFilter,
		at position: Int,
	) {
		if self.collectionID != collectionID || self.filter != filter {
			reset()
			self.collectionID = collectionID
			self.filter = filter
		}
		if let index = index(matching: article) {
			entries[index].article = article
			return
		}
		for alias in Self.aliases(of: article) {
			indicesByAlias[alias] = entries.count
		}
		entries.append(Entry(article: article, position: position))
	}

	/// Refreshes the retained copies with newer state for the same stories.
	mutating func update(from articles: [Recommendation]) {
		guard entries.isEmpty == false else { return }
		for article in articles {
			guard let index = index(matching: article) else { continue }
			entries[index].article = article
		}
	}

	mutating func update(_ article: Recommendation, _ change: (inout Recommendation) -> Void) {
		guard let index = index(matching: article) else { return }
		change(&entries[index].article)
	}

	mutating func reset() {
		collectionID = nil
		filter = nil
		entries.removeAll()
		indicesByAlias.removeAll()
	}

	/// The displayed list: `articles` (unfiltered, already in `order`) filtered
	/// by `filter`, plus every kept story. A kept story still in `articles`
	/// stays at its row; one that is gone is merged back at its sorted position.
	func displayed(
		_ articles: [Recommendation],
		filter: ReaderArticleFilter,
		order: ArticleSortOrder,
	) -> [Recommendation] {
		var present = Set<Int>()
		var result: [Recommendation] = []
		result.reserveCapacity(articles.count)
		for article in articles {
			if let index = index(matching: article) {
				present.insert(index)
				result.append(article)
			} else if filter.includes(article) {
				result.append(article)
			}
		}
		let missing = entries.indices.filter { present.contains($0) == false }
		guard missing.isEmpty == false else { return result }
		if order == .recommended {
			for index in missing.sorted(by: { entries[$0].position < entries[$1].position }) {
				result.insert(entries[index].article, at: min(entries[index].position, result.count))
			}
			return result
		}
		return order.sorted(result + missing.map { entries[$0].article })
	}

	/// Called for every row of the displayed list, so look up both identities
	/// directly instead of building an alias set per row.
	private func index(matching article: Recommendation) -> Int? {
		guard indicesByAlias.isEmpty == false else { return nil }
		let readerID = ReaderArticleIdentity.normalized(article.readerId)
		if readerID.isEmpty == false, let index = indicesByAlias[readerID] { return index }
		let id = ReaderArticleIdentity.normalized(article.id)
		if id.isEmpty == false, let index = indicesByAlias[id] { return index }
		return nil
	}

	private static func aliases(of article: Recommendation) -> Set<String> {
		ReaderArticleIdentity.aliases(id: article.id, readerID: article.readerId)
	}
}
