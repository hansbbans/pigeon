import SwiftUI

struct ReaderSidebarView: View {
	var selectedDestination: ((ReaderDestination) -> Void)? = nil
	@Environment(ReaderAppModel.self) private var model
	@State private var editorRoute: LibraryEditorRoute?
	@State private var feedPendingUnsubscribe: FeedSubscription?
	@State private var folderPendingDeletion: FeedFolder?

	var body: some View {
		List {
			Section("Pigeon") {
				ForEach(ReaderSection.allCases) { section in
				destinationButton(
					.section(section),
					title: section.title,
					systemImage: section.systemImage
				)
				.keyboardShortcut(section.keyboardKey, modifiers: .command)
				}
			}

			Section("Library") {
				destinationButton(.allFeeds, title: "All Feeds", systemImage: "tray.full")

				ForEach(model.folders) { folder in
					DisclosureGroup {
						ForEach(folder.subscriptions) { subscription in
							feedButton(subscription)
								.padding(.leading, 6)
						}
					} label: {
						Button {
							select(.folder(folder.name))
						} label: {
							Label(folder.name, systemImage: "folder")
								.frame(maxWidth: .infinity, alignment: .leading)
								.contentShape(.rect)
						}
						.buttonStyle(.plain)
					}
					.listRowBackground(isSelected(.folder(folder.name)) ? Color.accentColor.opacity(0.14) : .clear)
					.contextMenu {
						Button("Open Folder", systemImage: "folder") {
							select(.folder(folder.name))
						}
						Button("Rename Folder", systemImage: "pencil") {
							editorRoute = .renameFolder(folder.name)
						}
						Button("Delete Folder", systemImage: "trash", role: .destructive) {
							folderPendingDeletion = folder
						}
					}
				}

				ForEach(model.unfiledSubscriptions) { subscription in
					feedButton(subscription)
				}

				if model.isLoadingLibrary && model.subscriptions.isEmpty {
					HStack {
						Spacer()
						ProgressView()
						Spacer()
					}
					.accessibilityLabel("Loading feeds")
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
				.keyboardShortcut("n", modifiers: [.command, .shift])
			}
		}
		.task {
			await model.loadLibrary()
		}
		.refreshable {
			await model.loadLibrary(force: true)
		}
		.sheet(item: $editorRoute) { route in
			LibraryManagementView(route: route)
				.environment(model)
		}
		.alert("Unsubscribe from feed?", isPresented: unsubscribeAlertBinding, presenting: feedPendingUnsubscribe) { subscription in
			Button("Unsubscribe", role: .destructive) {
				Task { await model.unsubscribe(subscription) }
			}
			Button("Cancel", role: .cancel) {}
		} message: { subscription in
			Text("\(subscription.title) will be removed from Pigeon and your other synced readers.")
		}
		.alert("Delete folder?", isPresented: deleteFolderAlertBinding, presenting: folderPendingDeletion) { folder in
			Button("Delete Folder", role: .destructive) {
				Task { await model.deleteFolder(folder.name) }
			}
			Button("Cancel", role: .cancel) {}
		} message: { folder in
			Text("Feeds in \(folder.name) will remain subscribed and move to No Folder.")
		}
	}

	private func destinationButton(_ destination: ReaderDestination, title: String, systemImage: String) -> some View {
		Button {
			select(destination)
		} label: {
			HStack {
				Label(title, systemImage: systemImage)
				Spacer()
				if isSelected(destination) {
					Image(systemName: "checkmark")
						.foregroundStyle(.tint)
						.accessibilityHidden(true)
				}
			}
		}
		.buttonStyle(.plain)
		.listRowBackground(isSelected(destination) ? Color.accentColor.opacity(0.14) : .clear)
	}

	private func feedButton(_ subscription: FeedSubscription) -> some View {
		destinationButton(.feed(subscription.id), title: subscription.title, systemImage: "dot.radiowaves.left.and.right")
			.contextMenu {
				Button("Rename Feed", systemImage: "pencil") {
					editorRoute = .renameFeed(subscription)
				}
				Button("Move to Folder", systemImage: "folder") {
					editorRoute = .moveFeed(subscription)
				}
				Divider()
				Button("Unsubscribe", systemImage: "trash", role: .destructive) {
					feedPendingUnsubscribe = subscription
				}
			}
	}

	private func isSelected(_ destination: ReaderDestination) -> Bool {
		model.selectedDestination == destination
	}

	private func select(_ destination: ReaderDestination) {
		model.select(destination: destination)
		selectedDestination?(destination)
	}

	private var unsubscribeAlertBinding: Binding<Bool> {
		Binding(
			get: { feedPendingUnsubscribe != nil },
			set: { if $0 == false { feedPendingUnsubscribe = nil } }
		)
	}

	private var deleteFolderAlertBinding: Binding<Bool> {
		Binding(
			get: { folderPendingDeletion != nil },
			set: { if $0 == false { folderPendingDeletion = nil } }
		)
	}
}
