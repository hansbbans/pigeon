import Foundation

/// What the tile home shows. It is a projection of the sidebar snapshot:
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
		let colorIndices = folderColorIndices(in: navigation)
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

	/// Every folder's colour. Colours are assigned across every folder, not
	/// only the visible ones, so the Unread filter never recolours a tile, and
	/// a folder's cards use the colour its tile has.
	static func folderColorIndices(in navigation: ReaderNavigationState) -> [String: Int] {
		let allFolderIDs = navigation.items.filter(\.isFolder).map(\.id)
		return Dictionary(zip(allFolderIDs, colorIndices(for: allFolderIDs)), uniquingKeysWith: { first, _ in first })
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

	/// The grid never grows wider than this, so tiles on an iPad in landscape
	/// stay close to the size they have on an iPhone.
	static let maximumContentWidth = 960.0
	/// From this width on, the layout has room for more than a phone's columns.
	static let wideLayoutMinimumWidth = 600.0
	private static let wideFolderTileWidth = 220.0
	private static let maximumFolderColumns = 4

	/// Three equal tiles in a row, so five views go three then two; four read
	/// better as two rows of two. A wide window keeps every view on one row.
	static func viewColumnCount(itemCount: Int, usesAccessibilitySize: Bool, availableWidth: Double? = nil) -> Int {
		let isWide = (availableWidth ?? 0) >= wideLayoutMinimumWidth
		if usesAccessibilitySize { return isWide ? min(max(itemCount, 1), 2) : 1 }
		if isWide { return max(itemCount, 1) }
		if itemCount == 4 { return 2 }
		return min(max(itemCount, 1), 3)
	}

	/// Two folder tiles across on a phone, more as the window widens.
	static func folderColumnCount(usesAccessibilitySize: Bool, availableWidth: Double? = nil) -> Int {
		let width = min(availableWidth ?? 0, maximumContentWidth)
		guard width >= wideLayoutMinimumWidth else { return usesAccessibilitySize ? 1 : 2 }
		if usesAccessibilitySize { return 2 }
		return min(max(Int(width / wideFolderTileWidth), 2), maximumFolderColumns)
	}
}
