import SwiftUI

enum LibraryEditorRoute: Identifiable {
	case addFeed
	case renameFeed(FeedSubscription)
	case editFeed(FeedSubscription)
	case renameFolder(String)

	var id: String {
		switch self {
		case .addFeed: "add-feed"
		case .renameFeed(let feed): "rename-feed:\(feed.id)"
		case .editFeed(let feed): "edit-feed:\(feed.id)"
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
		case .editFeed(let feed):
			EditFeedFoldersView(subscription: feed)
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
						.accessibilityIdentifier("add-feed-url")
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

private struct EditFeedFoldersView: View {
	let subscription: FeedSubscription
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@State private var selectedFolders: Set<String>
	@State private var newFolder = ""
	@State private var isSaving = false

	init(subscription: FeedSubscription) {
		self.subscription = subscription
		_selectedFolders = State(initialValue: Set(subscription.folderNames))
	}

	var body: some View {
		NavigationStack {
			Form {
				Section {
					if model.folders.isEmpty {
						Text("No folders yet")
							.foregroundStyle(.secondary)
					} else {
						ForEach(model.folders) { folder in
							Toggle(folder.name, isOn: folderSelection(for: folder.name))
								.accessibilityIdentifier("feed-folder-toggle-\(folder.name)")
						}
					}
				} header: {
					Text("Folders")
				} footer: {
					Text("Turn every folder off to leave this feed uncategorized.")
				}
				Section {
					TextField("New folder name", text: $newFolder)
						.textInputAutocapitalization(.words)
						.autocorrectionDisabled()
						.accessibilityIdentifier("new-feed-folder-name")
					if newFolderIsInvalid {
						Text("Folder names must be between 1 and 80 characters.")
							.font(.footnote)
							.foregroundStyle(.red)
					}
				} header: {
					Text("Create Folder")
				} footer: {
					Text("A new folder is created and assigned when you save.")
				}
			}
			.navigationTitle("Edit Feed")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Save") { save() }
						.accessibilityIdentifier("save-feed-folders")
						.disabled(isSaving || newFolderIsInvalid)
				}
			}
			.interactiveDismissDisabled(isSaving)
		}
	}

	private var trimmedNewFolder: String {
		newFolder.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	private var newFolderIsInvalid: Bool {
		newFolder.isEmpty == false && (trimmedNewFolder.isEmpty || trimmedNewFolder.count > 80)
	}

	private func folderSelection(for name: String) -> Binding<Bool> {
		Binding(
			get: { selectedFolders.contains(name) },
			set: { isSelected in
				if isSelected {
					selectedFolders.insert(name)
				} else {
					selectedFolders.remove(name)
				}
			},
		)
	}

	private func save() {
		isSaving = true
		var destinations = Array(selectedFolders)
		if trimmedNewFolder.isEmpty == false {
			destinations.append(trimmedNewFolder)
		}
		Task {
			if await model.moveFeed(subscription, toFolderNames: destinations) {
				dismiss()
			} else {
				isSaving = false
			}
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
