import SwiftUI

enum LibraryEditorRoute: Identifiable {
	case addFeed
	case renameFeed(FeedSubscription)
	case moveFeed(FeedSubscription)
	case renameFolder(String)

	var id: String {
		switch self {
		case .addFeed: "add-feed"
		case .renameFeed(let feed): "rename-feed:\(feed.id)"
		case .moveFeed(let feed): "move-feed:\(feed.id)"
		case .renameFolder(let name): "rename-folder:\(name)"
		}
	}
}

struct LibraryManagementView: View {
	let route: LibraryEditorRoute

	var body: some View {
		switch route {
		case .addFeed:
			AddFeedView()
		case .renameFeed(let feed):
			RenameFeedView(subscription: feed)
		case .moveFeed(let feed):
			MoveFeedView(subscription: feed)
		case .renameFolder(let name):
			RenameFolderView(originalName: name)
		}
	}
}

struct AddFeedView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@State private var urlText: String
	@State private var selectedFolder = ""
	@State private var newFolder = ""
	@State private var isSaving = false

	init(initialURL: String = "") {
		_urlText = State(initialValue: initialURL)
	}

	var body: some View {
		NavigationStack {
			Form {
				Section("Feed") {
					TextField("https://example.com/feed.xml", text: $urlText)
						.textContentType(.URL)
						.keyboardType(.URL)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
				}
				Section("Folder") {
					Picker("Existing folder", selection: $selectedFolder) {
						Text("None").tag("")
						ForEach(model.folders) { folder in
							Text(folder.name).tag(folder.name)
						}
					}
					TextField("Or create a new folder", text: $newFolder)
				}
			}
			.navigationTitle("Add Feed")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
				ToolbarItem(placement: .confirmationAction) {
					Button("Add") { save() }
						.disabled(urlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
				}
			}
			.interactiveDismissDisabled(isSaving)
		}
	}

	private func save() {
		isSaving = true
		let typedFolder = newFolder.trimmingCharacters(in: .whitespacesAndNewlines)
		let folder = typedFolder.isEmpty ? (selectedFolder.isEmpty ? nil : selectedFolder) : typedFolder
		Task {
			if await model.addFeed(urlText: urlText, folderName: folder) {
				dismiss()
			} else {
				isSaving = false
			}
		}
	}
}

private struct RenameFeedView: View {
	let subscription: FeedSubscription
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@State private var title: String
	@State private var isSaving = false

	init(subscription: FeedSubscription) {
		self.subscription = subscription
		_title = State(initialValue: subscription.title)
	}

	var body: some View {
		editorForm(title: "Rename Feed", fieldTitle: "Name", text: $title) {
			await model.renameFeed(subscription, to: title)
		}
	}

	private func editorForm(
		title navigationTitle: String,
		fieldTitle: String,
		text: Binding<String>,
		save: @escaping @MainActor () async -> Bool
	) -> some View {
		NavigationStack {
			Form {
				TextField(fieldTitle, text: text)
			}
			.navigationTitle(navigationTitle)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Save") {
						isSaving = true
						Task {
							if await save() { dismiss() } else { isSaving = false }
						}
					}
					.disabled(text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
				}
			}
			.interactiveDismissDisabled(isSaving)
		}
	}
}

private struct MoveFeedView: View {
	let subscription: FeedSubscription
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@State private var selectedFolder: String
	@State private var newFolder = ""
	@State private var isSaving = false

	init(subscription: FeedSubscription) {
		self.subscription = subscription
		_selectedFolder = State(initialValue: subscription.folderNames.first ?? "")
	}

	var body: some View {
		NavigationStack {
			Form {
				Section("Move \(subscription.title)") {
					Picker("Folder", selection: $selectedFolder) {
						Text("No Folder").tag("")
						ForEach(model.folders) { folder in
							Text(folder.name).tag(folder.name)
						}
					}
				}
				Section("New Folder") {
					TextField("Folder name", text: $newFolder)
				}
			}
			.navigationTitle("Move Feed")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Move") { save() }
						.disabled(isSaving)
				}
			}
			.interactiveDismissDisabled(isSaving)
		}
	}

	private func save() {
		isSaving = true
		let typedFolder = newFolder.trimmingCharacters(in: .whitespacesAndNewlines)
		let destination = typedFolder.isEmpty ? (selectedFolder.isEmpty ? nil : selectedFolder) : typedFolder
		Task {
			if await model.moveFeed(subscription, to: destination) { dismiss() } else { isSaving = false }
		}
	}
}

private struct RenameFolderView: View {
	let originalName: String
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@State private var name: String
	@State private var isSaving = false

	init(originalName: String) {
		self.originalName = originalName
		_name = State(initialValue: originalName)
	}

	var body: some View {
		NavigationStack {
			Form {
				TextField("Folder name", text: $name)
			}
			.navigationTitle("Rename Folder")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Save") {
						isSaving = true
						Task {
							if await model.renameFolder(originalName, to: name) { dismiss() } else { isSaving = false }
						}
					}
					.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
				}
			}
			.interactiveDismissDisabled(isSaving)
		}
	}
}
