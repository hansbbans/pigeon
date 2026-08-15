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
		@Bindable var typography = model.readerTypography

		NavigationStack {
			Form {
				Section("Connection") {
					LabeledContent("Server", value: model.session?.baseURL.absoluteString ?? "Not connected")
					Text("Your password is never stored here. Pigeon Reader keeps only the ClientLogin token in Keychain.")
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
					}
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

					Button("Reset reading controls", systemImage: "arrow.counterclockwise") {
						typography.reset()
					}
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
}
