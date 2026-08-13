import SwiftUI

struct ReaderSidebarView: View {
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
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
				ForEach(model.smartNavigationItems) { item in
					ReaderNavigationRowView(
						item: item,
						isSelected: model.selectedNavigationID == item.id,
						onSelect: { model.select(item: item) },
					)
					.tag(item.id)
					.keyboardShortcut(item.smartSection?.keyboardKey ?? "1", modifiers: .command)
				}
			}

			if model.folderNavigationItems.isEmpty == false {
				Section("Folders") {
					ForEach(model.folderNavigationItems) { folder in
						ReaderFolderNavigationRowView(
							folder: folder,
							isExpanded: model.isFolderExpanded(folder),
							isSelected: model.selectedNavigationID == folder.id,
							onToggle: { model.toggleFolder(folder) },
							onSelect: { model.select(item: folder) },
						)
						.tag(folder.id)

						if model.isFolderExpanded(folder) {
							ForEach(model.feedNavigationItems(in: folder)) { feed in
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

			if model.uncategorizedFeedNavigationItems.isEmpty == false {
				Section("Feeds") {
					ForEach(model.uncategorizedFeedNavigationItems) { feed in
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
		.task {
			await model.loadNavigation()
		}
		.refreshable {
			await model.loadNavigation(force: true)
		}
	}
}
