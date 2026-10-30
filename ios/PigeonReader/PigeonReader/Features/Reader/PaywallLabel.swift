import SwiftUI

/// Marks an article whose newsletter copy stops at the publisher's paywall.
struct PaywallLabel: View {
	var body: some View {
		HStack(spacing: 3) {
			Image(systemName: "lock.fill")
				.imageScale(.small)
			Text("Paywall")
		}
			.font(.caption2.weight(.semibold))
			.textCase(.uppercase)
			.foregroundStyle(.secondary)
			.padding(.horizontal, 6)
			.padding(.vertical, 2)
			.background(.quaternary, in: .capsule)
			.fixedSize()
			.accessibilityLabel("Paywalled: this newsletter is a preview of the full article")
	}
}
