import SwiftUI

struct ReaderNewStoriesButton: View {
	let count: Int
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			Label(count > 0 ? "\(count) new \(count == 1 ? "story" : "stories")" : "Updated stories", systemImage: "arrow.up")
				.font(.subheadline.weight(.semibold))
				.padding(.horizontal, 16)
				.padding(.vertical, 10)
				.background(.regularMaterial, in: .capsule)
				.overlay { Capsule().stroke(.quaternary) }
		}
		.buttonStyle(.plain)
		.accessibilityIdentifier("show-new-stories")
		.accessibilityHint("Shows the updated list from the top")
		.padding(.top, 8)
	}
}
