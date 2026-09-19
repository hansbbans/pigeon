import SwiftUI

/// Keep list rows flat while acknowledging touch-down before navigation begins.
struct ReaderRowButtonStyle: ButtonStyle {
	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.contentShape(.rect)
			.background {
				RoundedRectangle(cornerRadius: 8)
					.fill(.primary.opacity(configuration.isPressed ? 0.08 : 0))
					.animation(configuration.isPressed ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
			}
	}
}
