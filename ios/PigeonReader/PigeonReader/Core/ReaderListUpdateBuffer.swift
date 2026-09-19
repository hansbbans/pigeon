import Foundation

/// The saved library can refresh independently of the page someone is reading.
/// Only this presentation copy waits for a gesture or explicit acceptance.
nonisolated struct ReaderListUpdateBuffer {
	private(set) var context: String?
	private(set) var articles: [Recommendation] = []
	private(set) var pendingArticles: [Recommendation]?
	private var pendingMayReorder = false

	var hasPendingUpdate: Bool { pendingArticles != nil }
	var needsAcceptance: Bool {
		pendingMayReorder == false && (pendingArticles.map { Self.movesExistingRows(from: articles, to: $0) } ?? false)
	}
	var newStoryCount: Int {
		let existing = Set(articles.map(\.id))
		return pendingArticles?.count(where: { existing.contains($0.id) == false }) ?? 0
	}

	func displayedArticles(in context: String, fallback: [Recommendation]) -> [Recommendation] {
		self.context == context ? articles : fallback
	}

	mutating func receive(_ latest: [Recommendation], context: String, holding: Bool, explicit: Bool = false,
		knownArticles: [Recommendation] = [], acceptsReordering: Bool = false, manuallyChangedArticleID: String? = nil) {
		let mayReorder = acceptsReordering || (pendingMayReorder && pendingArticles == latest)
		guard self.context == context else {
			self.context = context
			articles = latest
			pendingArticles = nil
			pendingMayReorder = false
			return
		}
		if let id = manuallyChangedArticleID {
			// Apply only the acted-on story. Unrelated background inserts and
			// reorders must still wait for the reader to accept them.
			let changedIndex = latest.firstIndex { $0.id == id }
			if let visibleIndex = articles.firstIndex(where: { $0.id == id }) {
				if let changedIndex {
					articles[visibleIndex] = latest[changedIndex]
				} else {
					articles.remove(at: visibleIndex)
				}
			} else if let changedIndex {
				let followingIDs = Set(latest.dropFirst(changedIndex + 1).map(\.id))
				let insertionIndex = articles.firstIndex { followingIDs.contains($0.id) } ?? articles.endIndex
				articles.insert(latest[changedIndex], at: insertionIndex)
			}
		}
		guard latest != articles else {
			pendingArticles = nil
			pendingMayReorder = false
			return
		}
		if explicit || articles.isEmpty {
			articles = latest
			pendingArticles = nil
			pendingMayReorder = false
		} else if holding {
			pendingArticles = latest
			pendingMayReorder = mayReorder
		} else if mayReorder == false && Self.movesExistingRows(from: articles, to: latest) {
			pendingArticles = latest
			pendingMayReorder = false
			// Read/star state stays truthful while newly inserted or reordered rows
			// wait for acceptance. Keep existing text and geometry stable.
			let byID = Dictionary((knownArticles + latest).map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
			let visibleIDs = Set(latest.map(\.id))
			articles = articles.compactMap { original in
				guard let current = byID[original.id] else { return original }
				if visibleIDs.contains(original.id) == false,
					current.isRead != original.isRead || current.isStarred != original.isStarred {
					return nil
				}
				var updated = original
				updated.isRead = current.isRead
				updated.isStarred = current.isStarred
				return updated
			}
		} else {
			articles = latest
			pendingArticles = nil
			pendingMayReorder = false
		}
	}

	mutating func acceptPending() {
		guard let pendingArticles else { return }
		articles = pendingArticles
		self.pendingArticles = nil
		pendingMayReorder = false
	}

	private static func movesExistingRows(from previous: [Recommendation], to next: [Recommendation]) -> Bool {
		guard previous.isEmpty == false else { return false }
		let previousIDs = previous.map(\.id)
		let previousSet = Set(previousIDs)
		let nextIDs = next.map(\.id)
		let nextSet = Set(nextIDs)
		let survivingPrevious = previousIDs.filter(nextSet.contains)
		let survivingNext = nextIDs.filter(previousSet.contains)
		if survivingPrevious != survivingNext { return true }
		guard let lastExisting = nextIDs.lastIndex(where: previousSet.contains) else {
			return nextIDs.isEmpty == false
		}
		return nextIDs.prefix(lastExisting).contains { previousSet.contains($0) == false }
	}
}
