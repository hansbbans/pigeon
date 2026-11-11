import Foundation

/// What the iPhone tile home shows. It is a projection of the sidebar snapshot:
/// the same views and folders, without unread counts as the organising idea.
nonisolated struct ReaderHomeTiles: Equatable, Sendable {
	nonisolated struct FolderTile: Equatable, Identifiable, Sendable {
		let item: ReaderNavigationItem
		/// Title of the newest cached story in the folder; nil until one is cached.
		let headline: String?
		let iconURLs: [URL]
		/// The first few feeds by name, shown while no headline is cached.
		let feedTitles: [String]

		var id: String { item.id }
	}

	/// Views that never get a tile. Unread stays available as a list filter and
	/// in the full library list.
	static let hiddenSections: Set<ReaderSection> = [.unread]
	static let maximumFeedIcons = 4
	static let maximumFeedTitles = 3

	let viewItems: [ReaderNavigationItem]
	let folders: [FolderTile]
	/// Unread stories received today, shown in the dateline.
	let newTodayCount: Int

	static func make(
		snapshot: ReaderSidebarPresentationSnapshot,
		navigation: ReaderNavigationState,
		cachedArticles: (ReaderNavigationItem) -> [Recommendation]?,
	) -> Self {
		let viewItems = snapshot.smartItems.filter { item in
			guard let section = item.smartSection else { return false }
			return hiddenSections.contains(section) == false
		}
		let folders = snapshot.folderItems.map { folder in
			let feeds = snapshot.feeds(in: folder.id)
			return FolderTile(
				item: folder,
				headline: cachedArticles(folder).flatMap(newestHeadline(in:)),
				iconURLs: Array(feeds.compactMap(\.iconURL).prefix(maximumFeedIcons)),
				feedTitles: Array(feeds.map(\.title).prefix(maximumFeedTitles)),
			)
		}
		let today = navigation.items.first { $0.smartSection == .today }
		return Self(viewItems: viewItems, folders: folders, newTodayCount: max(today?.unreadCount ?? 0, 0))
	}

	/// Cached lists follow the reader's sort order, which may be oldest first,
	/// so the newest story is found by date. Untitled stories are skipped.
	static func newestHeadline(in articles: [Recommendation]) -> String? {
		var newest: (title: String, receivedAt: Date, id: String)?
		for article in articles {
			let title = article.title.trimmingCharacters(in: .whitespacesAndNewlines)
			guard title.isEmpty == false else { continue }
			if let current = newest,
				(article.receivedAt, article.id) <= (current.receivedAt, current.id) {
				continue
			}
			newest = (title, article.receivedAt, article.id)
		}
		return newest?.title
	}

	/// Three equal tiles in a row; four read better as two rows of two.
	static func viewColumnCount(itemCount: Int, usesAccessibilitySize: Bool) -> Int {
		if usesAccessibilitySize { return 1 }
		if itemCount == 4 { return 2 }
		return min(max(itemCount, 1), 3)
	}
}
