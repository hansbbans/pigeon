import SwiftUI

nonisolated enum ReaderHomeAccessibility {
	static let tiles = "reader-home-tiles"
	static let dateline = "reader-home-dateline"
	static let allFeeds = "reader-home-all-feeds"
	static let showTiles = "reader-home-show-tiles"
}

/// Home: a tile for each view and folder, on iPhone and iPad alike. Counts are
/// deliberately absent here; each list shows its own count once opened.
struct ReaderHomeTilesView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.dynamicTypeSize) private var dynamicTypeSize
	@State private var editorRoute: LibraryEditorRoute?
	/// Width of the scroll view, measured so wide windows get more columns.
	@State private var availableWidth: Double?
	let onShowLibrary: () -> Void

	var body: some View {
		let tiles = makeTiles()

		ScrollView {
			VStack(alignment: .leading, spacing: 24) {
				LazyVGrid(columns: viewColumns(for: tiles), spacing: 10) {
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

				if tiles.folders.isEmpty == false {
					VStack(alignment: .leading, spacing: 10) {
						Text("Folders")
							.font(.footnote.weight(.semibold))
							.foregroundStyle(.pigeonSecondary)
							.accessibilityAddTraits(.isHeader)
						LazyVGrid(columns: folderColumns, spacing: 10) {
							ForEach(tiles.folders) { folder in
								Button {
									model.select(item: folder.item)
								} label: {
									ReaderHomeFolderTile(folder: folder)
								}
								.buttonStyle(ReaderHomeTileButtonStyle())
								.accessibilityLabel(folder.item.title)
								.accessibilityValue("\(folder.item.unreadCount) unread")
								.accessibilityHint(folder.headline.map { "Newest: \($0)" } ?? "")
								.accessibilityIdentifier(ReaderSidebarAccessibility.item(folder.id))
							}
						}
					}
				}

				Button(action: onShowLibrary) {
					HStack {
						Text("All Feeds")
						Spacer(minLength: 8)
						Image(systemName: "chevron.right")
							.font(.footnote.weight(.semibold))
							.foregroundStyle(.pigeonSecondary)
							.accessibilityHidden(true)
					}
					.padding(.horizontal, 14)
					.frame(maxWidth: .infinity, minHeight: 48)
					.background(ReaderHomeTileStyle.background, in: ReaderHomeTileStyle.shape)
				}
				.buttonStyle(ReaderHomeTileButtonStyle())
				.accessibilityHint("Shows every folder and feed")
				.accessibilityIdentifier(ReaderHomeAccessibility.allFeeds)
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
		.accessibilityIdentifier(ReaderHomeAccessibility.tiles)
		.navigationTitle("Pigeon")
		.navigationBarTitleDisplayMode(.inline)
		.toolbar(removing: .title)
		.toolbar {
			ToolbarItem(placement: .topBarLeading) {
				ReaderHomeDateline(newTodayCount: tiles.newTodayCount)
			}
			.sharedBackgroundVisibility(.hidden)
			ReaderLookToolbarItem()
			ReaderLibraryToolbarItems(editorRoute: $editorRoute)
			ReaderSettingsToolbarItem()
		}
		.refreshable {
			await model.refreshLibrary()
		}
		.sheet(item: $editorRoute) { route in
			LibraryManagementView(route: route)
		}
	}

	private func makeTiles() -> ReaderHomeTiles {
		let snapshot = ReaderSidebarPresentationSnapshot.make(
			accountID: model.session?.storageIdentity,
			selectedNavigationID: model.selectedNavigationID,
			sidebarFilter: model.sidebarFilter,
			enabledSmartViewSections: model.enabledSmartViewSections,
			navigation: model.navigation,
		)
		return ReaderHomeTiles.make(snapshot: snapshot, navigation: model.navigation) { folder in
			model.hasCachedCollection(folder) ? model.allArticles(for: folder) : nil
		}
	}

	private func viewColumns(for tiles: ReaderHomeTiles) -> [GridItem] {
		let count = ReaderHomeTiles.viewColumnCount(
			itemCount: tiles.viewItems.count,
			usesAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
			availableWidth: availableWidth,
		)
		return Array(repeating: GridItem(.flexible(), spacing: 10), count: count)
	}

	private var folderColumns: [GridItem] {
		let count = ReaderHomeTiles.folderColumnCount(
			usesAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
			availableWidth: availableWidth,
		)
		return Array(repeating: GridItem(.flexible(), spacing: 10), count: count)
	}
}

/// The date and what arrived today, in kicker type. This is the only number
/// on the home screen.
private struct ReaderHomeDateline: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	let newTodayCount: Int

	var body: some View {
		// The count may not change at midnight, so the date keeps its own clock.
		TimelineView(.everyMinute) { context in
			HStack(spacing: 6) {
				Text(context.date, format: .dateTime.weekday(.abbreviated).month(.abbreviated).day())
				if newTodayCount > 0 {
					Text(verbatim: "·")
						.accessibilityHidden(true)
					Text("\(newTodayCount) new")
						.monospacedDigit()
						.contentTransition(reduceMotion ? .identity : .numericText(value: Double(newTodayCount)))
				}
			}
		}
		.font(.caption2.weight(.bold))
		.textCase(.uppercase)
		.tracking(0.8)
		.foregroundStyle(.pigeonSecondary)
		.lineLimit(1)
		.fixedSize()
		.animation(reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false), value: newTodayCount)
		.accessibilityElement(children: .combine)
		.accessibilityIdentifier(ReaderHomeAccessibility.dateline)
	}
}

struct ReaderHomeViewTile: View {
	let item: ReaderNavigationItem

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			Image(systemName: item.smartSection?.systemImage ?? "newspaper")
				.font(.title3)
				.symbolRenderingMode(.hierarchical)
				.foregroundStyle(.tint)
				.frame(height: 26, alignment: .center)
				.accessibilityHidden(true)
			Text(item.title)
				.font(.subheadline.weight(.semibold))
				.foregroundStyle(.primary)
				.lineLimit(2)
				.minimumScaleFactor(0.85)
				.multilineTextAlignment(.leading)
		}
		.padding(12)
		.frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
		.background(ReaderHomeTileStyle.background, in: ReaderHomeTileStyle.shape)
	}
}

struct ReaderHomeFolderTile: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.readerTypeface) private var readerTypeface
	let folder: ReaderHomeTiles.FolderTile
	/// Home's grid keeps tiles even; a full-width tile fits its content.
	var minHeight: Double = 136

	var body: some View {
		let color = FrontPageKickerPalette.color(at: folder.colorIndex)

		VStack(alignment: .leading, spacing: 8) {
			Text(folder.item.title)
				.font(.caption2.weight(.bold))
				.textCase(.uppercase)
				.tracking(0.8)
				.foregroundStyle(color)
				.lineLimit(1)
			if let headline = folder.headline {
				Text(headline)
					.font(ReaderTypography.storyTitle(readerTypeface))
					.foregroundStyle(.primary)
					.lineLimit(4)
					.multilineTextAlignment(.leading)
					.contentTransition(reduceMotion ? .identity : .opacity)
					.transition(.opacity)
			} else if folder.feedTitles.isEmpty == false {
				Text(folder.feedTitles.joined(separator: ", "))
					.font(.subheadline)
					.foregroundStyle(.pigeonSecondary)
					.lineLimit(3)
					.multilineTextAlignment(.leading)
					.transition(.opacity)
			}
			Spacer(minLength: 0)
			if folder.iconURLs.isEmpty == false {
				HStack(spacing: 6) {
					ForEach(folder.iconURLs, id: \.self) { url in
						ReaderHomeFeedIcon(url: url)
					}
				}
				.accessibilityHidden(true)
			}
		}
		.padding(.horizontal, 12)
		.padding(.top, 14)
		.padding(.bottom, 12)
		.frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
		.readerTileBackground(barColor: color)
		.animation(ReaderMotion.contentArrival(reduceMotion: reduceMotion), value: folder.headline)
	}
}
