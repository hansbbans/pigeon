import SwiftUI

/// Marks an article whose newsletter copy stops at the publisher's paywall.
///
/// The label runs inline at the start of the title, so it sits next to the
/// title at any width and a truncated title can never cut it off.
enum PaywallLabel {
	/// Spoken after Read/Unread and Starred, since the title's accessibility
	/// label stays the bare title.
	static let accessibilityValue = "Paywalled"

	/// The title, led by the paywall label when the article is paywalled.
	/// The label keeps its own small caption font; callers style the returned
	/// text with the title's font as usual. VoiceOver reads only the title, so
	/// callers announce the paywall with `accessibilityValue`.
	static func title(_ title: String, isPaywalled: Bool?) -> Text {
		guard isPaywalled == true else { return Text(title) }
		return Text("\(label)\u{2002}\(title)")
			.accessibilityLabel(title)
	}

	private static var label: Text {
		Text("\(Image(systemName: "lock.fill"))\u{00A0}PAYWALL")
			.font(.caption2.weight(.semibold))
			.tracking(0.6)
			.foregroundStyle(.secondary)
	}
}
