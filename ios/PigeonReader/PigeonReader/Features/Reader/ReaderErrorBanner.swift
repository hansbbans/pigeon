import SwiftUI

struct ReaderErrorBanner: View {
	let message: String
	let dismiss: () -> Void

	var body: some View {
		HStack {
			Label(message, systemImage: "exclamationmark.triangle.fill")
				.frame(maxWidth: .infinity, alignment: .leading)
			Button("Dismiss", systemImage: "xmark", action: dismiss)
				.labelStyle(.iconOnly)
		}
		.padding()
		.background(.regularMaterial)
		.accessibilityElement(children: .contain)
	}
}
