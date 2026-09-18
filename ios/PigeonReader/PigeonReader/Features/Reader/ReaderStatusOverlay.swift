import SwiftUI

/// Transient status floats above content without changing the split view's
/// safe area, navigation bar, or the reader's saved scroll geometry.
struct ReaderStatusOverlay: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var dismissedOfflineNotice = false

	private var visibleMessage: String? {
		if let error = model.errorMessage { return error }
		return model.isOffline && dismissedOfflineNotice == false
			? "Offline — showing your saved library" : nil
	}

	var body: some View {
		Group {
			if let message = model.errorMessage {
				ReaderErrorBanner(message: message, dismiss: model.clearError)
					.clipShape(.rect(cornerRadius: 16))
					.accessibilityIdentifier("reader-error-banner")
					.transition(.opacity)
			} else if model.isOffline && dismissedOfflineNotice == false {
				HStack(spacing: 8) {
					Label("Offline — showing your saved library", systemImage: "wifi.slash")
						.font(.subheadline)
						.fixedSize(horizontal: false, vertical: true)
					Button("Dismiss offline message", systemImage: "xmark") {
						dismissedOfflineNotice = true
					}
					.labelStyle(.iconOnly)
					.frame(minWidth: 44, minHeight: 44)
				}
				.padding(.leading, 16)
				.padding(.trailing, 4)
				.background(.regularMaterial, in: .rect(cornerRadius: 16))
				.accessibilityIdentifier("offline-library-banner")
				.transition(.opacity)
			}
		}
		.frame(maxWidth: 560)
		.padding(.horizontal)
		.animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: visibleMessage)
		.onChange(of: model.isOffline) { _, offline in
			if offline == false { dismissedOfflineNotice = false }
		}
		.onChange(of: model.session?.storageIdentity) { _, _ in dismissedOfflineNotice = false }
		.onChange(of: visibleMessage, initial: true) { _, message in
			if let message { AccessibilityNotification.Announcement(message).post() }
		}
	}
}
