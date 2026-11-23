import Foundation

/// What All Feeds shows in the Cards look: every view (Unread included), each
/// folder's Home tile followed by its feeds, then the feeds in no folder. It
/// projects the same sidebar snapshot as the library list, so the Unread
/// filter hides the same folders and feeds.
nonisolated struct ReaderLibraryTiles: Equatable, Sendable {
	nonisolated struct FeedTile: Equatable, Identifiable, Sendable {
		let item: ReaderNavigationItem
		/// Title of the newest cached story; nil until one is cached.
		let headline: String?
		/// The folder's colour, or the feed's own kicker colour outside a folder.
		let colorIndex: Int

		var id: String { item.id }
	}

	nonisolated struct FolderGroup: Equatable, Identifiable, Sendable {
		let folder: ReaderHomeTiles.FolderTile
		let feeds: [FeedTile]

		var id: String { folder.id }
	}

	let viewItems: [ReaderNavigationItem]
	let folders: [FolderGroup]
	let unfiledFeeds: [FeedTile]

	static func make(
		snapshot: ReaderSidebarPresentationSnapshot,
		navigation: ReaderNavigationState,
		cachedArticles: (ReaderNavigationItem) -> [Recommendation]?,
	) -> Self {
		let home = ReaderHomeTiles.make(snapshot: snapshot, navigation: navigation, cachedArticles: cachedArticles)
		func feedTile(_ feed: ReaderNavigationItem, colorIndex: Int) -> FeedTile {
			FeedTile(
				item: feed,
				headline: cachedArticles(feed).flatMap(ReaderHomeTiles.newestHeadline(in:)),
				colorIndex: colorIndex,
			)
		}
		return Self(
			viewItems: snapshot.smartItems,
			folders: home.folders.map { folder in
				FolderGroup(
					folder: folder,
					feeds: snapshot.feeds(in: folder.id).map { feedTile($0, colorIndex: folder.colorIndex) },
				)
			},
			unfiledFeeds: snapshot.uncategorizedFeedItems.map {
				feedTile($0, colorIndex: FrontPageKickerPalette.colorIndex(for: $0.streamID))
			},
		)
	}
}
