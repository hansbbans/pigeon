import SwiftUI

struct SettingsView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@State private var readwiseToken = ""
	@State private var readwiseMessage: String?
	@State private var readwiseMessageIsError = false
	@State private var offlineMessage: String?
	@State private var isShowingClearOfflineConfirmation = false

	var body: some View {
		@Bindable var model = model
		@Bindable var typography = model.readerTypography
		@Bindable var keyboardShortcuts = model.keyboardShortcuts

		NavigationStack {
			Form {
				Section("Connection") {
					LabeledContent("Server", value: model.session?.baseURL.absoluteString ?? "Not connected")
					Text("Your password is never stored here. Pigeon keeps only the ClientLogin token in Keychain.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}

				if let syncHealthService = model.syncHealthService {
					Section("Sync") {
						NavigationLink {
							SyncHealthView(service: syncHealthService)
						} label: {
							Label("Sync Health", systemImage: "heart.text.square")
						}
						Text("See which feeds are healthy, delayed, or failing, and retry recoverable failures.")
							.font(.footnote)
							.foregroundStyle(.secondary)
						NavigationLink {
							StaleFeedsView()
						} label: {
							Label("Stale Feeds", systemImage: "archivebox")
						}
					}
				}

				Section("Delivery and Import") {
					NavigationLink {
						FeedNotificationSettingsView()
					} label: {
						Label("Feed Notifications", systemImage: "bell")
					}
					NavigationLink {
						OPMLImportView()
					} label: {
						Label("Import OPML", systemImage: "square.and.arrow.down")
					}
					Toggle("Refresh on Low Data Mode", isOn: $model.allowsLowDataBackgroundRefresh)
					if let refreshedAt = model.lastBackgroundRefreshAt {
						LabeledContent("Background refresh") { Text(refreshedAt, style: .relative) }
					}
					Text("Background delivery is best effort. By default Pigeon waits for an unconstrained connection; iOS decides when the app and widgets may refresh.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}

				Section("Smart Views") {
					Toggle("For You", isOn: $model.isForYouSmartViewEnabled)
						.disabled(model.canDisableSmartView(.forYou) == false)
					Toggle("Starred", isOn: $model.isStarredSmartViewEnabled)
						.disabled(model.canDisableSmartView(.starred) == false)
					Toggle("Today", isOn: $model.isTodaySmartViewEnabled)
						.disabled(model.canDisableSmartView(.today) == false)
					Text("At least one smart view must stay enabled so Reader always has a home.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}

				Section("Offline Library") {
					LabeledContent("Status", value: model.isOffline ? "Offline" : "Up to date")
					LabeledContent("Saved articles", value: model.offlineStorageStats.articleCount.formatted())
					LabeledContent(
						"Local storage",
						value: ByteCountFormatter.string(
							fromByteCount: model.offlineStorageStats.bodyBytes,
							countStyle: .file,
						),
					)
					LabeledContent("Waiting to sync", value: model.offlineStorageStats.pendingMutationCount.formatted())
					if let lastSyncAt = model.offlineStorageStats.lastSyncAt {
						LabeledContent("Last sync") {
							Text(lastSyncAt, style: .relative)
						}
					}
					Button("Free space from older read articles", systemImage: "arrow.down.circle") {
						Task {
							let count = await model.cleanupOfflineBodies()
							offlineMessage = count == 1 ? "Removed one saved article body." : "Removed \(count) saved article bodies."
						}
					}
					Button("Clear saved articles", systemImage: "trash", role: .destructive) {
						isShowingClearOfflineConfirmation = true
					}
					if let offlineMessage {
						Text(offlineMessage)
							.font(.footnote)
							.foregroundStyle(.secondary)
					}
					Text("Unread and starred article bodies are protected during automatic cleanup. Pending changes stay queued until the server is reachable.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}

				Section("Reading") {
					Picker("Theme", selection: $typography.theme) {
						ForEach(ReaderTheme.allCases) { theme in
							Text(theme.title).tag(theme)
						}
					}
					Picker("Timeline", selection: $typography.timelineDensity) {
						ForEach(ReaderTimelineDensity.allCases) { density in
							Text(density.title).tag(density)
						}
					}
					Picker("Mark stories read", selection: $typography.markReadBehavior) {
						ForEach(ReaderMarkReadBehavior.allCases) { behavior in
							Text(behavior.title).tag(behavior)
						}
					}
					LabeledContent("Text size") {
						Text(typography.textScale, format: .percent.precision(.fractionLength(0)))
							.foregroundStyle(.secondary)
					}
					Slider(
						value: $typography.textScale,
						in: ReaderTypographySettings.textScaleRange,
						step: 0.05,
						label: { Text("Text size") },
					)
					.accessibilityValue(Text(typography.textScale, format: .percent.precision(.fractionLength(0))))

					LabeledContent("Line spacing") {
						Text(typography.lineHeight, format: .number.precision(.fractionLength(2)))
							.foregroundStyle(.secondary)
					}
					Slider(
						value: $typography.lineHeight,
						in: ReaderTypographySettings.lineHeightRange,
						step: 0.05,
						label: { Text("Line spacing") },
					)
					.accessibilityValue(Text(typography.lineHeight, format: .number.precision(.fractionLength(2))))

					LabeledContent("Page margins") {
						Text(typography.horizontalMargin, format: .number.precision(.fractionLength(0)))
							.foregroundStyle(.secondary)
					}
					Slider(
						value: $typography.horizontalMargin,
						in: ReaderTypographySettings.horizontalMarginRange,
						step: 4,
						label: { Text("Page margins") },
					)

					LabeledContent("Reading width") {
						Text(typography.columnWidth, format: .number.precision(.fractionLength(0)))
							.foregroundStyle(.secondary)
					}
					Slider(
						value: $typography.columnWidth,
						in: ReaderTypographySettings.columnWidthRange,
						step: 40,
						label: { Text("Reading width") },
					)

					Button("Reset reading controls", systemImage: "arrow.counterclockwise") {
						typography.reset()
					}
				}

				Section("Remote Images") {
					Picker("Loading", selection: $typography.remoteImagePolicy) {
						ForEach(ReaderRemoteImagePolicy.allCases) { policy in
							Text(policy.title).tag(policy)
						}
					}
					Text(remoteImageExplanation(for: typography.remoteImagePolicy))
						.font(.footnote)
						.foregroundStyle(.secondary)
				}

				Section("Keyboard Shortcuts") {
					Picker("Next article", selection: $keyboardShortcuts.next) {
						ForEach(ReaderArticleKeyboardShortcut.allCases) { shortcut in
							Text(shortcut.title).tag(shortcut)
						}
					}
					Picker("Previous article", selection: $keyboardShortcuts.previous) {
						ForEach(ReaderArticleKeyboardShortcut.allCases) { shortcut in
							Text(shortcut.title).tag(shortcut)
						}
					}
					Button("Reset article shortcuts", systemImage: "arrow.counterclockwise") {
						keyboardShortcuts.reset()
					}
					Text("Use these shortcuts with an external keyboard while an article is selected. If both actions are assigned the same key, Pigeon swaps the other action to keep them distinct.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}

				Section("Personalization") {
					NavigationLink {
						PersonalizationSettingsView()
					} label: {
						Label("Signals, History, and Privacy", systemImage: "slider.horizontal.3")
					}
					Text("See exactly what affects recommendations, delete individual signals, reset preferences, or export your data.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}

				Section("Readwise Reader") {
					SecureField("Access token", text: $readwiseToken)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.textContentType(.password)
					Button("Save token", systemImage: "key.fill") {
						saveReadwiseToken()
					}
					.disabled(readwiseToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

					if model.hasReadwiseToken {
						Label("A token is stored securely.", systemImage: "checkmark.circle")
							.foregroundStyle(.secondary)
						Button("Remove token", systemImage: "trash", role: .destructive) {
							removeReadwiseToken()
						}
					}

					Text("Create an access token at readwise.io/access_token. Pigeon stores it only in Keychain.")
						.font(.footnote)
						.foregroundStyle(.secondary)
					if let readwiseMessage {
						Label(readwiseMessage, systemImage: readwiseMessageIsError ? "exclamationmark.triangle" : "checkmark.circle")
							.foregroundStyle(readwiseMessageIsError ? .red : .secondary)
					}
				}

				Section {
					Button("Disconnect", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
						model.disconnect()
						dismiss()
					}
				}
			}
			.navigationTitle("Settings")
			.toolbar {
				ToolbarItem(placement: .confirmationAction) {
					Button("Done") { dismiss() }
				}
			}
			.task {
				await model.refreshOfflineStorageStats()
			}
			.confirmationDialog(
				"Clear saved articles?",
				isPresented: $isShowingClearOfflineConfirmation,
				titleVisibility: .visible,
			) {
				Button("Clear Saved Articles", role: .destructive) {
					Task {
						await model.clearOfflineArticles()
						offlineMessage = "Saved articles cleared. Feeds will cache again as you open or refresh them."
					}
				}
			} message: {
				Text("Pending read, star, folder, and feedback changes will not be deleted.")
			}
		}
	}

	private func saveReadwiseToken() {
		do {
			try model.saveReadwiseToken(readwiseToken)
			readwiseToken = ""
			readwiseMessage = "Token saved securely."
			readwiseMessageIsError = false
		} catch {
			readwiseMessage = error.localizedDescription
			readwiseMessageIsError = true
		}
	}

	private func removeReadwiseToken() {
		do {
			try model.removeReadwiseToken()
			readwiseMessage = "Token removed."
			readwiseMessageIsError = false
		} catch {
			readwiseMessage = error.localizedDescription
			readwiseMessageIsError = true
		}
	}

	private func remoteImageExplanation(for policy: ReaderRemoteImagePolicy) -> String {
		switch policy {
		case .normal:
			"Images load directly from publishers. They can see your network address and the image URL may identify the newsletter recipient."
		case .blocked:
			"Images stay blocked until you request one. Loading a requested image connects directly to its publisher."
		case .privacyProxied:
			"Pigeon's authenticated server fetches images for you. Publishers see the proxy, not your device address or cookies."
		}
	}
}
