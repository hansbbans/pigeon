import SwiftUI

struct ConnectionView: View {
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
		@Bindable var model = model

		NavigationStack {
			Form {
				Section {
					Text("Welcome to Pigeon")
						.font(.largeTitle.bold())
						.fixedSize(horizontal: false, vertical: true)
						.accessibilityAddTraits(.isHeader)
					Text("Connect the reader to the Pigeon server that already powers your feeds.")
						.font(.body)
						.foregroundStyle(.secondary)
				}

				Section {
					Text("Server")
						.font(.headline)
						.accessibilityAddTraits(.isHeader)
					TextField("https://pigeon.example", text: $model.serverURLText)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.keyboardType(.URL)
						.textContentType(.URL)
				}

				Section {
					Text("API password")
						.font(.headline)
						.accessibilityAddTraits(.isHeader)
					SecureField("Password", text: $model.password)
						.textContentType(.password)
					Text("The password is used once for ClientLogin. Only the resulting token and server URL are saved in Keychain.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}

				if let errorMessage = model.errorMessage {
					Section {
						Label(errorMessage, systemImage: "exclamationmark.triangle")
							.foregroundStyle(.red)
					}
				}

				Section {
					Button {
						Task { await model.connect() }
					} label: {
						if model.isConnecting {
							ProgressView()
								.frame(maxWidth: .infinity)
						} else {
							Text("Connect")
								.frame(maxWidth: .infinity)
						}
					}
					.disabled(!model.canConnect)
				}
			}
			.formStyle(.grouped)
			.navigationTitle("Pigeon")
			.navigationBarTitleDisplayMode(.inline)
		}
	}
}

#Preview {
	ConnectionView()
		.environment(ReaderAppModel())
}
