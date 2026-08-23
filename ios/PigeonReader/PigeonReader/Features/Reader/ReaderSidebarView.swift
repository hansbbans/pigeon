import SwiftUI

struct ReaderSidebarView: View {
	@Environment(ReaderAppModel.self) private var model
	@State private var editorRoute: LibraryEditorRoute?

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
								feedRow(feed, indentation: 28)
							}
						}
					}
				}
			}

			if model.visibleUncategorizedFeedNavigationItems.isEmpty == false {
				Section("Feeds") {
					ForEach(model.visibleUncategorizedFeedNavigationItems) { feed in
						feedRow(feed)
					}
				}
			}
		}
		.listStyle(.sidebar)
		.navigationTitle("Pigeon")
		.toolbar {
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
			ReaderSettingsToolbarItem()
		}
		.refreshable {
			await model.prepareOfflineLibrary()
		}
		.sheet(item: $editorRoute) { route in
			LibraryManagementView(route: route)
		}
	}

	private func feedRow(_ feed: ReaderNavigationItem, indentation: CGFloat = 0) -> some View {
		ReaderNavigationRowView(
			item: feed,
			isSelected: model.selectedNavigationID == feed.id,
			indentation: indentation,
			onSelect: { model.select(item: feed) },
		)
		.tag(feed.id)
		.contextMenu {
			Button("Edit Feed", systemImage: "pencil") {
				guard let subscription = model.subscription(id: feed.streamID) else {
					model.errorMessage = "This feed is not available to edit yet. Refresh your library and try again."
					return
				}
				editorRoute = .editFeed(subscription)
			}
		}
	}
}
