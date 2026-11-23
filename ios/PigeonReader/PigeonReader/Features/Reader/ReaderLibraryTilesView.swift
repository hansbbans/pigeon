import SwiftUI

nonisolated enum ReaderLibraryTilesAccessibility {
	static let tiles = "reader-library-tiles"
}

/// All Feeds in the Cards look: the library as tiles in the Home style
/// instead of a stock sidebar list. Views, then each folder's tile with its
/// feeds as smaller tiles under it, then feeds in no folder.
struct ReaderLibraryTilesView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.dynamicTypeSize) private var dynamicTypeSize
	@State private var editorRoute: LibraryEditorRoute?
	@State private var folderPendingDeletion: String?
	@State private var feedPendingUnsubscribe: FeedSubscription?
	@State private var availableWidth: Double?
	let onShowHome: (() -> Void)?

	var body: some View {
		let tiles = makeTiles()

		ScrollView {
			VStack(alignment: .leading, spacing: 24) {
				LazyVGrid(columns: viewColumns(count: tiles.viewItems.count), spacing: 10) {
					ForEach(tiles.viewItems) { item in
						Button {
							model.select(item: item)
						} label: {
							ReaderHomeViewTile(item: item)
						}
						.buttonStyle(ReaderHomeTileButtonStyle())
						.accessibilityLabel(item.title)
						.accessibilityValue("\(item.unreadCount) unread")
						.accessibilityIdentifier(ReaderSidebarAccessibility.item(item.id))
						.keyboardShortcut(item.smartSection?.keyboardKey ?? "1", modifiers: .command)
					}
				}

				ForEach(tiles.folders) { group in
					VStack(alignment: .leading, spacing: 10) {
						Button {
							model.select(item: group.folder.item)
						} label: {
							ReaderHomeFolderTile(folder: group.folder, minHeight: 0)
						}
						.buttonStyle(ReaderHomeTileButtonStyle())
						.accessibilityLabel(group.folder.item.title)
						.accessibilityValue("\(group.folder.item.unreadCount) unread")
						.accessibilityHint(group.folder.headline.map { "Newest: \($0)" } ?? "")
						.accessibilityIdentifier(ReaderSidebarAccessibility.item(group.id))
						.contextMenu {
							ReaderFolderMenu(
								folder: group.folder.item,
								editorRoute: $editorRoute,
								folderPendingDeletion: $folderPendingDeletion,
							)
						}
						feedGrid(group.feeds)
					}
				}

				if tiles.unfiledFeeds.isEmpty == false {
					VStack(alignment: .leading, spacing: 10) {
						Text("Feeds")
							.font(.footnote.weight(.semibold))
							.foregroundStyle(.pigeonSecondary)
							.accessibilityAddTraits(.isHeader)
						feedGrid(tiles.unfiledFeeds)
					}
				}
			}
			.padding(.horizontal, 16)
			.padding(.top, 8)
			.padding(.bottom, 24)
			.frame(maxWidth: ReaderHomeTiles.maximumContentWidth)
			.frame(maxWidth: .infinity)
			.animation(reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false), value: tiles.folders.map(\.id))
		}
		.onGeometryChange(for: Double.self) { geometry in
			Double(geometry.size.width)
		} action: { _, width in
			availableWidth = width
		}
		.scrollEdgeEffectStyle(.soft, for: .top)
		.background(Color(.systemGroupedBackground))
		.accessibilityIdentifier(ReaderLibraryTilesAccessibility.tiles)
		.navigationTitle("All Feeds")
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			if let onShowHome {
				ToolbarItem(placement: .topBarLeading) {
					Button("Home", systemImage: "square.grid.2x2", action: onShowHome)
						.accessibilityIdentifier(ReaderHomeAccessibility.showTiles)
						.accessibilityHint("Returns to the tile view")
				}
			}
			ReaderLibraryToolbarItems(editorRoute: $editorRoute)
			ReaderSettingsToolbarItem()
		}
		.refreshable {
			await model.refreshLibrary()
		}
		.sheet(item: $editorRoute) { route in
			LibraryManagementView(route: route)
		}
		.modifier(ReaderLibraryItemDialogs(
			folderPendingDeletion: $folderPendingDeletion,
			feedPendingUnsubscribe: $feedPendingUnsubscribe,
		))
	}

	private func feedGrid(_ feeds: [ReaderLibraryTiles.FeedTile]) -> some View {
		LazyVGrid(columns: feedColumns, spacing: 10) {
			ForEach(feeds) { feed in
				Button {
					model.select(item: feed.item)
				} label: {
					ReaderLibraryFeedTile(
						feed: feed,
						remoteImagePolicy: model.readerTypography.remoteImagePolicy,
					)
				}
				.buttonStyle(ReaderHomeTileButtonStyle())
				.accessibilityLabel(feed.item.title)
				.accessibilityValue("\(feed.item.unreadCount) unread")
				.accessibilityHint(feed.headline.map { "Newest: \($0)" } ?? "")
				.accessibilityIdentifier(ReaderSidebarAccessibility.item(feed.id))
				.contextMenu {
					ReaderFeedMenu(
						feed: feed.item,
						editorRoute: $editorRoute,
						feedPendingUnsubscribe: $feedPendingUnsubscribe,
						open: { model.select(item: feed.item) },
					)
				}
			}
		}
	}

	private func makeTiles() -> ReaderLibraryTiles {
		let snapshot = ReaderSidebarPresentationSnapshot.make(
			accountID: model.session?.storageIdentity,
			selectedNavigationID: model.selectedNavigationID,
			sidebarFilter: model.sidebarFilter,
			enabledSmartViewSections: model.enabledSmartViewSections,
			navigation: model.navigation,
		)
		return ReaderLibraryTiles.make(snapshot: snapshot, navigation: model.navigation) { item in
			model.hasCachedCollection(item) ? model.allArticles(for: item) : nil
		}
	}

	private func viewColumns(count itemCount: Int) -> [GridItem] {
		let count = ReaderHomeTiles.viewColumnCount(
			itemCount: itemCount,
			usesAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
			availableWidth: availableWidth,
		)
		return Array(repeating: GridItem(.flexible(), spacing: 10), count: count)
	}

	/// Feed tiles are smaller than folder tiles: the folder grid's columns.
	private var feedColumns: [GridItem] {
		let count = ReaderHomeTiles.folderColumnCount(
			usesAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
			availableWidth: availableWidth,
		)
		return Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: count)
	}
}

/// A feed: favicon and name, then its newest cached headline, with its
/// folder's colour bar. Smaller than a folder tile.
private struct ReaderLibraryFeedTile: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.readerTypeface) private var readerTypeface
	let feed: ReaderLibraryTiles.FeedTile
	let remoteImagePolicy: ReaderRemoteImagePolicy

	private var isCompact: Bool { feed.headline == nil }

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 6) {
				// Favicons are publisher-hosted, so they follow the image policy.
				if remoteImagePolicy == .normal, let iconURL = feed.item.iconURL {
					ReaderHomeFeedIcon(url: iconURL)
						.accessibilityHidden(true)
				}
				Text(feed.item.title)
					.font(.footnote.weight(.semibold))
					.foregroundStyle(.primary)
					.lineLimit(2)
					.multilineTextAlignment(.leading)
			}
			if let headline = feed.headline {
				Text(headline)
					.font(ReaderTypography.body(readerTypeface, size: 15, relativeTo: .subheadline))
					.foregroundStyle(.pigeonSecondary)
					.lineLimit(3)
					.multilineTextAlignment(.leading)
					.contentTransition(reduceMotion ? .identity : .opacity)
					.transition(.opacity)
			}
		}
		.padding(.horizontal, 12)
		.padding(.top, isCompact ? 11 : 12)
		.padding(.bottom, isCompact ? 8 : 10)
		// Without a cached headline the tile is one row of favicon and name,
		// as Home's folder tile shrinks to its names, not an empty box.
		.frame(maxWidth: .infinity, minHeight: isCompact ? 44 : 60, alignment: isCompact ? .leading : .topLeading)
		.readerTileBackground(barColor: FrontPageKickerPalette.color(at: feed.colorIndex))
		.animation(ReaderMotion.contentArrival(reduceMotion: reduceMotion), value: feed.headline)
	}
}
