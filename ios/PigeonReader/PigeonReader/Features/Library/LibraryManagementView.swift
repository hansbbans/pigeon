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
	@State private var channelSearch = YouTubeChannelSearchState()

	init(initialURL: String = "") {
		_urlText = State(initialValue: initialURL)
		var initialSearch = YouTubeChannelSearchState()
		initialSearch.updateInput(initialURL)
		_channelSearch = State(initialValue: initialSearch)
	}

	var body: some View {
		NavigationStack {
			Form {
				SettingsErrorSection()
				Section {
					TextField("Website URL or YouTube channel", text: $urlText)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.accessibilityIdentifier("add-feed-url")
						.submitLabel(.search)
						.onSubmit {
							guard YouTubeChannelSearchInput.searchQuery(from: urlText) != nil else { return }
							channelSearch.retry()
						}
						.onChange(of: urlText) { _, newValue in
							channelSearch.updateInput(newValue)
						}
				} header: {
					Text("Feed")
				} footer: {
					Text("Paste a website or feed link, or enter a YouTube handle such as mkbhd.")
				}
				if shouldShowChannelSearch {
					Section("YouTube Channels") {
						if channelSearch.isSearching {
							ProgressView("Searching YouTube")
								.accessibilityIdentifier("youtube-search-status")
						}
						ForEach(channelSearch.channels) { channel in
							Button {
								guard channel.validFeedURL != nil else { return }
								channelSearch.select(channel)
							} label: {
								VStack(alignment: .leading, spacing: 4) {
									HStack {
										Text(channel.title)
											.font(.headline)
										if channelSearch.selectedChannel?.id == channel.id {
											Image(systemName: "checkmark.circle.fill")
												.foregroundStyle(.tint)
										}
									}
									Text(channel.channelLabel)
										.font(.footnote)
										.foregroundStyle(.secondary)
									if channel.description.isEmpty == false {
										Text(channel.description)
											.font(.subheadline)
											.foregroundStyle(.secondary)
											.lineLimit(3)
									}
								}
								.frame(maxWidth: .infinity, alignment: .leading)
								.contentShape(Rectangle())
							}
							.buttonStyle(.plain)
							.disabled(channel.validFeedURL == nil)
							.accessibilityIdentifier("youtube-channel-result-\(channel.id)")
							.accessibilityValue(channelSearch.selectedChannel?.id == channel.id ? "Selected" : "")
						}
						if let message = channelSearch.message {
							Text(message)
								.font(.footnote)
								.foregroundStyle(.secondary)
								.accessibilityIdentifier("youtube-search-message")
						}
						if let errorMessage = channelSearch.errorMessage {
							Label(errorMessage, systemImage: "exclamationmark.triangle")
								.font(.footnote)
								.foregroundStyle(.red)
								.accessibilityIdentifier("youtube-search-error")
							Button("Retry search", systemImage: "arrow.clockwise") {
								channelSearch.retry()
							}
							.accessibilityIdentifier("youtube-search-retry")
						}
						if channelSearch.hasCompletedSearch,
							channelSearch.channels.isEmpty,
							channelSearch.message == nil,
							channelSearch.errorMessage == nil {
							Text("No matching YouTube channels found.")
								.foregroundStyle(.secondary)
								.accessibilityIdentifier("youtube-search-empty")
						}
					}
				}
				Section("Folder") {
					Picker("Existing folder", selection: $selectedFolder) {
						Text("None").tag("")
						ForEach(model.folders) { folder in
							Text(folder.name).tag(folder.name)
						}
					}
					TextField("Or create a new folder", text: $newFolder)
						.accessibilityIdentifier("add-feed-new-folder")
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
						.accessibilityIdentifier("add-feed")
						.disabled(subscriptionURLText == nil || isSaving)
				}
			}
			.interactiveDismissDisabled(isSaving)
			.onDisappear {
				model.clearSettingsError()
			}
		}
		.task(id: channelSearch.request) {
			await searchYouTube(for: channelSearch.request)
		}
	}

	private var shouldShowChannelSearch: Bool {
		guard YouTubeChannelSearchInput.searchQuery(from: urlText) != nil else { return false }
		return channelSearch.isSearching
			|| channelSearch.hasCompletedSearch
			|| channelSearch.channels.isEmpty == false
			|| channelSearch.message != nil
			|| channelSearch.errorMessage != nil
	}

	private var subscriptionURLText: String? {
		if let selectedChannel = channelSearch.selectedChannel {
			let currentQuery = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
			guard channelSearch.query == currentQuery else { return nil }
			guard selectedChannel.validFeedURL != nil else { return nil }
			return selectedChannel.feedURL.trimmingCharacters(in: .whitespacesAndNewlines)
		}
		let candidate = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
		guard YouTubeChannelSearchInput.httpURL(from: candidate) != nil else { return nil }
		return candidate
	}

	private func searchYouTube(for request: YouTubeChannelSearchRequest) async {
		guard let query = YouTubeChannelSearchInput.searchQuery(from: request.query) else { return }
		do {
			try await Task.sleep(for: .milliseconds(500))
		} catch {
			return
		}
		guard Task.isCancelled == false, channelSearch.accepts(request) else { return }
		guard channelSearch.beginSearch(for: request) else { return }

		do {
			let response = try await model.searchYouTubeChannels(query: query)
			guard Task.isCancelled == false else { return }
			channelSearch.apply(response, for: request)
		} catch let error where isCancellation(error) {
			return
		} catch {
			guard Task.isCancelled == false else { return }
			channelSearch.fail(error.localizedDescription, for: request)
		}
	}

	private func save() {
		guard let subscriptionURLText else { return }
		isSaving = true
		let typedFolder = newFolder.trimmingCharacters(in: .whitespacesAndNewlines)
		let folder = typedFolder.isEmpty ? (selectedFolder.isEmpty ? nil : selectedFolder) : typedFolder
		Task {
			if await model.addFeed(urlText: subscriptionURLText, folderName: folder) {
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
				LibraryEditorErrorSection()
				TextField(fieldTitle, text: text)
					.accessibilityIdentifier("rename-feed-name")
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
				LibraryEditorErrorSection()
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
				LibraryEditorErrorSection()
				TextField("Folder name", text: $name)
					.accessibilityIdentifier("rename-folder-name")
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

private struct LibraryEditorErrorSection: View {
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
		if let message = model.errorMessage {
			Section {
				HStack(alignment: .top) {
					Label(message, systemImage: "exclamationmark.triangle.fill")
						.frame(maxWidth: .infinity, alignment: .leading)
					Button("Dismiss", systemImage: "xmark") {
						model.clearError()
					}
					.labelStyle(.iconOnly)
					.accessibilityLabel("Dismiss")
				}
				.accessibilityElement(children: .contain)
				.accessibilityIdentifier("library-editor-error")
			}
		}
	}
}
