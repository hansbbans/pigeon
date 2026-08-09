import SwiftUI

struct SettingsView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			Form {
				Section("Connection") {
					LabeledContent("Server", value: model.session?.baseURL.absoluteString ?? "Not connected")
					Text("Your password is never stored here. Pigeon Reader keeps only the ClientLogin token in Keychain.")
						.font(.footnote)
						.foregroundStyle(.secondary)
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
}
