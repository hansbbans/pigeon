import SwiftUI

struct SettingsView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.dismiss) private var dismiss
	@State private var readwiseToken = ""
	@State private var readwiseMessage: String?
	@State private var readwiseMessageIsError = false

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
