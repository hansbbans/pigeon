import SwiftUI

struct ReaderSidebarView: View {
	@Environment(ReaderAppModel.self) private var model
	@State private var editorRoute: LibraryEditorRoute?
	@State private var folderPendingDeletion: String?
	@State private var feedPendingUnsubscribe: FeedSubscription?

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
						.contextMenu {
							Button("Rename Folder", systemImage: "pencil") {
								editorRoute = .renameFolder(folder.title)
							}
							.accessibilityIdentifier("rename-folder")
							Button("Delete Folder", systemImage: "trash", role: .destructive) {
								folderPendingDeletion = folder.title
							}
							.accessibilityIdentifier("delete-folder")
						}

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
		.confirmationDialog(
			folderPendingDeletion.map { "Delete \"\($0)\"?" } ?? "Delete Folder?",
			isPresented: Binding(
				get: { folderPendingDeletion != nil },
				set: { if $0 == false { folderPendingDeletion = nil } },
			),
			titleVisibility: .visible,
		) {
			Button("Delete Folder", role: .destructive) {
				guard let name = folderPendingDeletion else {
					return
				}
				folderPendingDeletion = nil
				Task { await model.deleteFolder(name) }
			}
			.accessibilityIdentifier("confirm-delete-folder")
		} message: {
			Text("Feeds in this folder stay subscribed. They move to Feeds if they have no other folder.")
		}
		.confirmationDialog(
			feedPendingUnsubscribe.map { "Unsubscribe from \"\($0.title)\"?" } ?? "Unsubscribe?",
			isPresented: Binding(
				get: { feedPendingUnsubscribe != nil },
				set: { if $0 == false { feedPendingUnsubscribe = nil } },
			),
			titleVisibility: .visible,
		) {
			Button("Unsubscribe", role: .destructive) {
				guard let subscription = feedPendingUnsubscribe else {
					return
				}
				feedPendingUnsubscribe = nil
				Task { _ = await model.unsubscribe(subscription) }
			}
			.accessibilityIdentifier("confirm-unsubscribe-feed")
			Button("Cancel", role: .cancel) {
				feedPendingUnsubscribe = nil
			}
		} message: {
			Text("Pigeon will stop fetching this feed. Existing stories stay in your library until they age out.")
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
			Button("Rename Feed", systemImage: "character.cursor.ibeam") {
				guard let subscription = model.subscription(id: feed.streamID) else {
					model.errorMessage = "This feed is not available to rename yet. Refresh your library and try again."
					return
				}
				editorRoute = .renameFeed(subscription)
			}
			.accessibilityIdentifier("rename-feed")
			Button("Unsubscribe", systemImage: "trash", role: .destructive) {
				guard let subscription = model.subscription(id: feed.streamID) else {
					model.errorMessage = "This feed is not available to unsubscribe yet. Refresh your library and try again."
					return
				}
				feedPendingUnsubscribe = subscription
			}
			.accessibilityIdentifier("unsubscribe-feed")
		}
	}
}
