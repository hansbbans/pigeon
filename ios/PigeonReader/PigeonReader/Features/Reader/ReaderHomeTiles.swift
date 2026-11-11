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
		/// Index into `FrontPageKickerPalette`, unique per folder while colours last.
		let colorIndex: Int

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
		// Colours are assigned across every folder, not only the visible ones,
		// so the Unread filter never recolours a tile.
		let allFolderIDs = navigation.items.filter(\.isFolder).map(\.id)
		let colorIndices = Dictionary(
			zip(allFolderIDs, colorIndices(for: allFolderIDs)),
			uniquingKeysWith: { first, _ in first },
		)
		let folders = snapshot.folderItems.map { folder in
			let feeds = snapshot.feeds(in: folder.id)
			var seenIcons = Set<URL>()
			let icons = feeds.compactMap(\.iconURL).filter { seenIcons.insert($0).inserted }
			return FolderTile(
				item: folder,
				headline: cachedArticles(folder).flatMap(newestHeadline(in:)),
				iconURLs: Array(icons.prefix(maximumFeedIcons)),
				feedTitles: Array(feeds.map(\.title).prefix(maximumFeedTitles)),
				colorIndex: colorIndices[folder.id] ?? FrontPageKickerPalette.colorIndex(for: folder.id),
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
			// Compare first: this runs over whole folders on every cache change.
			if let current = newest,
				(article.receivedAt, article.id) <= (current.receivedAt, current.id) {
				continue
			}
			let title = article.title.trimmingCharacters(in: .whitespacesAndNewlines)
			guard title.isEmpty == false else { continue }
			newest = (title, article.receivedAt, article.id)
		}
		return newest?.title
	}

	/// Each folder starts from the hash of its id, so its colour is stable
	/// across launches, and moves to the next free colour when two folders
	/// collide. With more folders than colours, the rest keep their hash.
	static func colorIndices(for folderIDs: [String], paletteCount: Int = FrontPageKickerPalette.count) -> [Int] {
		guard paletteCount > 0 else { return folderIDs.map { _ in 0 } }
		var used = Set<Int>()
		return folderIDs.map { id in
			var index = FrontPageKickerPalette.colorIndex(for: id) % paletteCount
			if used.count < paletteCount {
				while used.contains(index) {
					index = (index + 1) % paletteCount
				}
			}
			used.insert(index)
			return index
		}
	}

	/// Three equal tiles in a row; four read better as two rows of two.
	static func viewColumnCount(itemCount: Int, usesAccessibilitySize: Bool) -> Int {
		if usesAccessibilitySize { return 1 }
		if itemCount == 4 { return 2 }
		return min(max(itemCount, 1), 3)
	}
}
