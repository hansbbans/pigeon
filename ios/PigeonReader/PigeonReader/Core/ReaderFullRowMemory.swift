import Foundation

/// Which stories each list has already drawn in full this app session, the
/// web app's `fullRowIdsByList`. A read story renders compact (one muted line)
/// unless its list has shown it in full before: so a story read while the
/// list is open keeps its height, nothing moves under the reader's finger,
/// and a saved scroll position stays valid when the reader comes back.
/// Keyed by list context (account, collection, filter, sort, search).
nonisolated struct ReaderFullRowMemory: Sendable {
	private var idsByList: [String: Set<String>] = [:]

	func isCompact(_ article: Recommendation, in list: String) -> Bool {
		article.isRead && idsByList[list]?.contains(article.id) != true
	}

	/// Records the stories a list draws in full (the unread ones; a read one
	/// already shown in full is in the set). Call after each change of the
	/// drawn stories.
	mutating func noteDrawn(_ articles: [Recommendation], in list: String) {
		let unread = articles.lazy.filter { $0.isRead == false }.map(\.id)
		var ids = idsByList[list] ?? []
		var changed = false
		for id in unread where ids.insert(id).inserted { changed = true }
		if changed { idsByList[list] = ids }
	}

	mutating func removeAll() {
		idsByList.removeAll()
	}
}
