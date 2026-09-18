import SwiftUI

struct ReaderSaveConfirmationView: View {
	let confirmation: ReaderSaveConfirmation
	let dismiss: () -> Void

	var body: some View {
		HStack(spacing: 12) {
			Label(confirmation.message, systemImage: confirmation.isSuccess ? "checkmark.circle.fill" : "clock")
				.font(.subheadline)
				.frame(maxWidth: .infinity, alignment: .leading)
			Button("Dismiss confirmation", systemImage: "xmark", action: dismiss)
				.labelStyle(.iconOnly)
				.frame(minWidth: 44, minHeight: 44)
		}
		.padding(.leading, 16)
		.padding(.trailing, 4)
		.padding(.vertical, 4)
		.background(.regularMaterial, in: .rect(cornerRadius: 16))
		.padding(.horizontal)
		.padding(.bottom, 8)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("reader-save-confirmation")
	}
}
