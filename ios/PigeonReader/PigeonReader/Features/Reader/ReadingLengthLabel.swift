import SwiftUI

extension EnvironmentValues {
	/// Mirrors the "Show reading time" setting so rows and headers need no extra parameter.
	@Entry var showsReadingTime = true
}

extension Recommendation {
	/// The reading-length label to show, honoring the setting; nil hides it.
	@MainActor func readingLengthLabel(showsReadingTime: Bool) -> String? {
		showsReadingTime ? ReadingLength.label(for: self) : nil
	}
}
