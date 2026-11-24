import SwiftUI

/// Add Feed and the collection filter, shared by the tile home and the library
/// list. The Reeder library (`collectsMenus`) shows only ＋ and ⋯ beside the
/// top-bar look switch, with the filter, the look (named, for a reader who
/// looks for it there) and Settings in ⋯: it is the app's root, with no Home
/// to hold Settings.
struct ReaderLibraryToolbarItems: ToolbarContent {
	@Environment(ReaderAppModel.self) private var model
	@Binding var editorRoute: LibraryEditorRoute?
	var collectsMenus = false

	var body: some ToolbarContent {
		@Bindable var model = model
		ToolbarItem(placement: .topBarTrailing) {
			Button("Add Feed", systemImage: "plus") {
				editorRoute = .addFeed
			}
			.accessibilityIdentifier("add-feed")
			.accessibilityHint("Subscribe to a website or feed URL")
		}
		ToolbarItem(placement: .topBarTrailing) {
			if collectsMenus {
				Menu("More", systemImage: "ellipsis") {
					filterMenu
					Menu("Look", systemImage: "rectangle.grid.1x2") {
						Picker("Look", selection: lookBinding) {
							ForEach(ReaderLook.allCases) { look in
								Text(look.title).tag(look)
							}
						}
						.accessibilityIdentifier("library-look-options")
					}
					.accessibilityValue(model.readerTypography.look.title)
					.accessibilityIdentifier("library-look")
					Divider()
					Button("Settings", systemImage: "gearshape") {
						model.isShowingSettings = true
					}
					.keyboardShortcut(",", modifiers: .command)
				}
				.accessibilityIdentifier("library-more")
			} else {
				filterMenu
			}
		}
	}

	private var lookBinding: Binding<ReaderLook> {
		Binding(
			get: { model.readerTypography.look },
			set: { model.readerTypography.look = $0 },
		)
	}

	private var filterMenu: some View {
		@Bindable var model = model
		return Menu("Filter", systemImage: "line.3.horizontal.decrease") {
			Picker("Filter collections", selection: $model.sidebarFilter) {
				ForEach(ReaderSidebarFilter.allCases) { filter in
					Text(filter.title)
						.tag(filter)
				}
			}
		}
		.accessibilityLabel(ReaderAccessibilityText.filterCollections)
		.accessibilityValue(model.sidebarFilter.title)
		.accessibilityHint(ReaderAccessibilityText.filterCollectionsHint)
	}
}
