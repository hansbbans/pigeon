import SwiftUI

/// Add Feed and the collection filter, shared by the tile home and the library list.
struct ReaderLibraryToolbarItems: ToolbarContent {
	@Environment(ReaderAppModel.self) private var model
	@Binding var editorRoute: LibraryEditorRoute?

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
			Menu("Filter", systemImage: "line.3.horizontal.decrease") {
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
}
