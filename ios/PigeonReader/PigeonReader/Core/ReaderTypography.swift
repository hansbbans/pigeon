import SwiftUI

extension EnvironmentValues {
	/// Mirrors Settings → Typeface so story titles and the reader follow it without a parameter.
	@Entry var readerTypeface: ReaderTypeface = .geistSerif
}

extension ReaderTypeface {
	/// PostScript names of the bundled faces. Geist Serif ships only Regular, and SwiftUI does not
	/// synthesize bold or italic for a custom font, so its titles and italics are set in Regular.
	/// Allo, a sans, sets titles in SemiBold: Bold reads as shouting at list-title sizes.
	nonisolated var regularFontName: String {
		switch self {
		case .geistSerif: "GeistSerif-Regular"
		case .bookerly: "Bookerly-Regular"
		case .allo: "Allo-Regular"
		}
	}

	nonisolated var titleFontName: String {
		switch self {
		case .geistSerif: "GeistSerif-Regular"
		case .bookerly: "Bookerly-Bold"
		case .allo: "Allo-SemiBold"
		}
	}

	nonisolated var italicFontName: String {
		switch self {
		case .geistSerif: "GeistSerif-Regular"
		case .bookerly: "Bookerly-Italic"
		case .allo: "Allo-Oblique"
		}
	}
}

enum ReaderTypography {
	static let articleTitlePointSize = 25.0
	static let articleBodyPointSize = 18.0

	static func storyTitle(_ typeface: ReaderTypeface) -> Font {
		title(typeface, size: 17, relativeTo: .body)
	}

	static func title(_ typeface: ReaderTypeface, size: Double, relativeTo style: Font.TextStyle) -> Font {
		Font.custom(typeface.titleFontName, size: size, relativeTo: style)
	}

	static func body(_ typeface: ReaderTypeface, size: Double, relativeTo style: Font.TextStyle) -> Font {
		Font.custom(typeface.regularFontName, size: size, relativeTo: style)
	}

	static func italic(_ typeface: ReaderTypeface, size: Double, relativeTo style: Font.TextStyle) -> Font {
		Font.custom(typeface.italicFontName, size: size, relativeTo: style)
	}

	static func articleTitle(textScale: Double, typeface: ReaderTypeface) -> Font {
		title(typeface, size: scaledPointSize(articleTitlePointSize, textScale: textScale), relativeTo: .title)
	}

	static func articleBody(textScale: Double, typeface: ReaderTypeface) -> Font {
		body(typeface, size: scaledPointSize(articleBodyPointSize, textScale: textScale), relativeTo: .body)
	}

	static func scaledPointSize(_ base: Double, textScale: Double) -> Double {
		base * clampedTextScale(textScale)
	}

	static func clampedTextScale(_ textScale: Double) -> Double {
		min(max(textScale, ReaderTypographySettings.textScaleRange.lowerBound), ReaderTypographySettings.textScaleRange.upperBound)
	}
}

extension ReaderTheme {
	nonisolated var preferredColorScheme: ColorScheme? {
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
