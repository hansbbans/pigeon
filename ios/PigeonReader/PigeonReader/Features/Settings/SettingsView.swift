import SwiftUI

struct SettingsView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@State private var offlineMessage: String?
	@State private var isShowingClearOfflineConfirmation = false

	var body: some View {
		@Bindable var model = model
		@Bindable var typography = model.readerTypography
		@Bindable var keyboardShortcuts = model.keyboardShortcuts

		NavigationStack {
			Form {
				SettingsErrorSection()

				Section("Connection") {
					LabeledContent("Server", value: model.session?.baseURL.absoluteString ?? "Not connected")
					Text("Your password is never stored here. Pigeon keeps only the ClientLogin token in Keychain.")
						.font(.footnote)
						.foregroundStyle(.pigeonSecondary)
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
							.foregroundStyle(.pigeonSecondary)
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
						.foregroundStyle(.pigeonSecondary)
				}

				Section("Views") {
					Toggle("For You", isOn: $model.isForYouSmartViewEnabled)
						.disabled(model.canDisableSmartView(.forYou) == false)
					Toggle("Unread", isOn: $model.isUnreadSmartViewEnabled)
						.disabled(model.canDisableSmartView(.unread) == false)
					Toggle("Starred", isOn: $model.isStarredSmartViewEnabled)
						.disabled(model.canDisableSmartView(.starred) == false)
					Toggle("Today", isOn: $model.isTodaySmartViewEnabled)
						.disabled(model.canDisableSmartView(.today) == false)
					Text("At least one smart view must stay enabled so Reader always has a home.")
						.font(.footnote)
						.foregroundStyle(.pigeonSecondary)
				}

				Section("Offline Library") {
					LabeledContent("Status", value: model.offlineLibraryStatusTitle)
					LabeledContent("Saved articles", value: model.offlineStorageStats.articleCount.formatted())
					LabeledContent(
						"Local storage",
						value: ByteCountFormatter.string(
							fromByteCount: model.offlineStorageStats.bodyBytes,
							countStyle: .file,
						),
					)
					LabeledContent("Waiting to sync", value: model.offlineStorageStats.pendingMutationCount.formatted())
					if let lastError = model.offlineStorageStats.lastError, lastError.isEmpty == false {
						LabeledContent("Last sync error") {
							Text(lastError)
								.multilineTextAlignment(.trailing)
								.textSelection(.enabled)
						}
					}
					if let lastSuccessAt = model.offlineStorageStats.lastSuccessAt {
						LabeledContent("Last successful sync") {
							Text(lastSuccessAt, style: .relative)
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
							.foregroundStyle(.pigeonSecondary)
					}
					Text("Unread and starred article bodies are protected during automatic cleanup. Pending changes stay queued until the server is reachable.")
						.font(.footnote)
						.foregroundStyle(.pigeonSecondary)
				}

				Section("Reading") {
					Picker("Default article view", selection: $model.defaultArticleView) {
						ForEach(ReaderMode.defaultArticleViewChoices) { mode in
							Text(mode.title).tag(mode)
						}
					}
					.accessibilityIdentifier("default-article-view-picker")
					Picker("Theme", selection: $typography.theme) {
						ForEach(ReaderTheme.allCases) { theme in
							Text(theme.title).tag(theme)
						}
					}
					Picker("Layout", selection: $typography.homeLayout) {
						ForEach(ReaderHomeLayout.allCases) { layout in
							Text(layout.title).tag(layout)
						}
					}
					.accessibilityIdentifier("home-layout-picker")
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
					Toggle("Show reading time", isOn: $typography.showsReadingTime)
						.accessibilityHint("Shows the length of articles and videos over 10 minutes.")
						.accessibilityIdentifier("show-reading-time-toggle")
					LabeledContent("Text size") {
						Text(typography.textScale, format: .percent.precision(.fractionLength(0)))
							.foregroundStyle(.pigeonSecondary)
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
							.foregroundStyle(.pigeonSecondary)
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
							.foregroundStyle(.pigeonSecondary)
					}
					Slider(
						value: $typography.horizontalMargin,
						in: ReaderTypographySettings.horizontalMarginRange,
						step: 4,
						label: { Text("Page margins") },
					)

					LabeledContent("Reading width") {
						Text(typography.columnWidth, format: .number.precision(.fractionLength(0)))
							.foregroundStyle(.pigeonSecondary)
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
						.foregroundStyle(.pigeonSecondary)
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
						.foregroundStyle(.pigeonSecondary)
				}

				Section("Personalization") {
					NavigationLink {
						PersonalizationSettingsView()
					} label: {
						Label("Signals, History, and Privacy", systemImage: "slider.horizontal.3")
					}
					Text("See exactly what affects recommendations, delete individual signals, reset preferences, or export your data.")
						.font(.footnote)
						.foregroundStyle(.pigeonSecondary)
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
		.onDisappear {
			model.clearSettingsError()
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
