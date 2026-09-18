import SwiftUI

struct ReaderSaveConfirmationModifier: ViewModifier {
	@Binding var confirmation: ReaderSaveConfirmation?
	@Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled

	func body(content: Content) -> some View {
		content
			.overlay(alignment: .bottom) {
				if let confirmation {
					ReaderSaveConfirmationView(confirmation: confirmation, dismiss: dismiss)
						.transition(.opacity)
				}
			}
			.animation(.easeOut(duration: 0.12), value: confirmation?.id)
			.sensoryFeedback(.success, trigger: confirmation?.id) { _, newID in
				newID != nil && confirmation?.isSuccess == true
			}
			.task(id: confirmation?.id) {
				guard let message = confirmation else { return }
				AccessibilityNotification.Announcement(message.message).post()
				// Keep feedback available until dismissed when VoiceOver is active.
				guard voiceOverEnabled == false else { return }
				do {
					try await Task.sleep(for: .seconds(4))
					try Task.checkCancellation()
					guard voiceOverEnabled == false, confirmation?.id == message.id else { return }
					dismiss()
				} catch {
					// SwiftUI cancels this task when replaced or removed.
					return
				}
			}
	}

	private func dismiss() {
		confirmation = nil
	}
}
