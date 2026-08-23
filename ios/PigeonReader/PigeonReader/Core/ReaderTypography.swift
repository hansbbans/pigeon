import SwiftUI

enum ReaderTypography {
	static let storyTitle = Font.custom("Bookerly-Bold", size: 17, relativeTo: .body)
	static let articleTitle = Font.custom("Bookerly-Bold", size: 25, relativeTo: .title)
	static let articleBody = Font.custom("Bookerly-Regular", size: 18, relativeTo: .body)
}

extension ReaderTheme {
	var preferredColorScheme: ColorScheme? {
		switch self {
		case .system: nil
		case .light, .sepia: .light
		case .darkGray, .dark: .dark
		}
	}
}

/// How the article reader applies a theme's light/dark override.
///
/// `.preferredColorScheme` is a window-level preference. In a regular-width
/// `NavigationSplitView` it tints the sidebar and article list along with
/// the reader. Compact (full-screen) readers can still use it.
nonisolated enum ReaderThemeColorSchemePlacement: Equatable, Sendable {
	case inheritSystem
	case preferredColorScheme(ColorScheme)
	case environmentOnly(ColorScheme)

	static func resolve(theme: ReaderTheme, isCompactReader: Bool) -> Self {
		guard let colorScheme = theme.preferredColorScheme else {
			return .inheritSystem
		}
		return isCompactReader ? .preferredColorScheme(colorScheme) : .environmentOnly(colorScheme)
	}

	var usesPreferredColorScheme: Bool {
		if case .preferredColorScheme = self {
			return true
		}
		return false
	}
}

extension View {
	func readerThemeColorScheme(_ placement: ReaderThemeColorSchemePlacement) -> some View {
		modifier(ReaderThemeColorSchemeModifier(placement: placement))
	}
}

private struct ReaderThemeColorSchemeModifier: ViewModifier {
	let placement: ReaderThemeColorSchemePlacement

	@ViewBuilder
	func body(content: Content) -> some View {
		switch placement {
		case .inheritSystem:
			content
		case .preferredColorScheme(let colorScheme):
			content.preferredColorScheme(colorScheme)
		case .environmentOnly(let colorScheme):
			content.environment(\.colorScheme, colorScheme)
		}
	}
}
