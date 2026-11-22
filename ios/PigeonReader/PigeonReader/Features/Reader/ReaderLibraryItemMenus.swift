import SwiftUI

/// Library actions shared by the library list and the All Feeds tiles: the
/// folder and feed context menus and the confirmations they lead to.
struct ReaderFolderMenu: View {
	let folder: ReaderNavigationItem
	@Binding var editorRoute: LibraryEditorRoute?
	@Binding var folderPendingDeletion: String?

	var body: some View {
		Button("Rename Folder", systemImage: "pencil") {
			editorRoute = .renameFolder(folder.title)
		}
		.accessibilityIdentifier("rename-folder")
		Button("Delete Folder", systemImage: "trash", role: .destructive) {
			folderPendingDeletion = folder.title
		}
		.accessibilityIdentifier("delete-folder")
	}
}

struct ReaderFeedMenu: View {
	@Environment(ReaderAppModel.self) private var model
	let feed: ReaderNavigationItem
	@Binding var editorRoute: LibraryEditorRoute?
	@Binding var feedPendingUnsubscribe: FeedSubscription?
	let open: () -> Void

	var body: some View {
		Button("Open Feed", systemImage: "newspaper", action: open)
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

/// The confirmations behind Delete Folder and Unsubscribe.
struct ReaderLibraryItemDialogs: ViewModifier {
	@Environment(ReaderAppModel.self) private var model
	@Binding var folderPendingDeletion: String?
	@Binding var feedPendingUnsubscribe: FeedSubscription?

	func body(content: Content) -> some View {
		content
			.confirmationDialog(
				folderPendingDeletion.map { "Delete \"\($0)\"?" } ?? "Delete Folder?",
				isPresented: Binding(
					get: { folderPendingDeletion != nil },
					set: { if $0 == false { folderPendingDeletion = nil } },
				),
				titleVisibility: .visible,
			) {
				Button("Delete Folder", role: .destructive) {
					guard let name = folderPendingDeletion else { return }
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
					guard let subscription = feedPendingUnsubscribe else { return }
					feedPendingUnsubscribe = nil
					Task { _ = await model.unsubscribe(subscription) }
				}
				.accessibilityIdentifier("confirm-unsubscribe-feed")
				Button("Cancel", role: .cancel) { feedPendingUnsubscribe = nil }
			} message: {
				Text("Pigeon will stop fetching this feed. Existing stories stay in your library until they age out.")
			}
	}
}
