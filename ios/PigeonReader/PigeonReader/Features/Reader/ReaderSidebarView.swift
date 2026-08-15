import SwiftUI

struct ReaderSidebarView: View {
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
		@Bindable var model = model
		let selection = Binding<String?>(
			get: { model.selectedNavigationID },
			set: { id in
				guard let id, let item = model.navigation.item(withID: id) else {
					return
				}
				model.select(item: item)
			},
		)

		List(selection: selection) {
			Section("Smart Views") {
				ForEach(model.visibleSmartNavigationItems) { item in
					ReaderNavigationRowView(
						item: item,
						isSelected: model.selectedNavigationID == item.id,
						onSelect: { model.select(item: item) },
					)
					.tag(item.id)
					.keyboardShortcut(item.smartSection?.keyboardKey ?? "1", modifiers: .command)
				}
			}

			if model.visibleFolderNavigationItems.isEmpty == false {
				Section("Folders") {
					ForEach(model.visibleFolderNavigationItems) { folder in
						ReaderFolderNavigationRowView(
							folder: folder,
							isExpanded: model.isFolderExpanded(folder),
							isSelected: model.selectedNavigationID == folder.id,
							onToggle: { model.toggleFolder(folder) },
							onSelect: { model.select(item: folder) },
						)
						.tag(folder.id)

						if model.isFolderExpanded(folder) {
							ForEach(model.visibleFeedNavigationItems(in: folder)) { feed in
								ReaderNavigationRowView(
									item: feed,
									isSelected: model.selectedNavigationID == feed.id,
									indentation: 28,
									onSelect: { model.select(item: feed) },
								)
								.tag(feed.id)
							}
						}
					}
				}
			}

			if model.visibleUncategorizedFeedNavigationItems.isEmpty == false {
				Section("Feeds") {
					ForEach(model.visibleUncategorizedFeedNavigationItems) { feed in
						ReaderNavigationRowView(
							item: feed,
							isSelected: model.selectedNavigationID == feed.id,
							onSelect: { model.select(item: feed) },
						)
						.tag(feed.id)
					}
				}
			}
		}
		.listStyle(.sidebar)
		.navigationTitle("Pigeon")
		.toolbar {
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
			ReaderSettingsToolbarItem()
		}
		.refreshable {
			await model.prepareOfflineLibrary()
		}
	}
}
