import Foundation
import SwiftUI
import Testing
@testable import PigeonReader

@MainActor
struct ReaderTypographySettingsTests {
	@Test
	func clampsAndPersistsTextSizeAndLineHeightWithinAccessibleBounds() throws {
		let suiteName = "pigeon-reader-typography-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let settings = ReaderTypographySettings(defaults: defaults)

		settings.textScale = 10
		settings.lineHeight = 0
		settings.horizontalMargin = 100
		settings.columnWidth = 100
		settings.theme = .sepia
		settings.remoteImagePolicy = .privacyProxied
		settings.timelineDensity = .compact
		settings.markReadBehavior = .onScroll
		#expect(settings.textScale == ReaderTypographySettings.textScaleRange.upperBound)
		#expect(settings.lineHeight == ReaderTypographySettings.lineHeightRange.lowerBound)
		#expect(defaults.double(forKey: "pigeon.reader.typography.text-scale") == ReaderTypographySettings.textScaleRange.upperBound)
		#expect(defaults.double(forKey: "pigeon.reader.typography.line-height") == ReaderTypographySettings.lineHeightRange.lowerBound)
		#expect(settings.horizontalMargin == ReaderTypographySettings.horizontalMarginRange.upperBound)
		#expect(settings.columnWidth == ReaderTypographySettings.columnWidthRange.lowerBound)

		let restored = ReaderTypographySettings(defaults: defaults)
		#expect(restored.theme == .sepia)
		#expect(restored.remoteImagePolicy == .privacyProxied)
		#expect(restored.timelineDensity == .compact)
		#expect(restored.markReadBehavior == .onScroll)

		settings.reset()
		#expect(settings.textScale == ReaderTypographySettings.defaultTextScale)
		#expect(settings.lineHeight == ReaderTypographySettings.defaultLineHeight)
		settings.increaseTextScale()
		#expect(settings.textScale == ReaderTypographySettings.defaultTextScale + 0.05)
		settings.decreaseTextScale()
		settings.decreaseTextScale()
		#expect(settings.textScale == ReaderTypographySettings.defaultTextScale - 0.05)
		#expect(settings.horizontalMargin == ReaderTypographySettings.defaultHorizontalMargin)
		#expect(settings.columnWidth == ReaderTypographySettings.defaultColumnWidth)
		#expect(settings.theme == .system)
	}

	@Test
	func keepsThemePickerOrderTitlesAndRawValuePersistenceCompatible() throws {
		let suiteName = "pigeon-reader-theme-compatibility-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }

		#expect(ReaderTheme.allCases == [.system, .light, .darkGray, .dark, .sepia])
		#expect(ReaderTheme.dark.rawValue == "dark")
		#expect(ReaderTheme.dark.title == "Black")
		#expect(ReaderTheme.darkGray.rawValue == "dark-gray")
		#expect(ReaderTheme.darkGray.title == "Dark Gray")

		defaults.set("dark", forKey: "pigeon.reader.theme")
		let restoredBlack = ReaderTypographySettings(defaults: defaults)
		#expect(restoredBlack.theme == .dark)
		#expect(restoredBlack.theme.title == "Black")

		restoredBlack.theme = .darkGray
		#expect(defaults.string(forKey: "pigeon.reader.theme") == "dark-gray")
		let restoredDarkGray = ReaderTypographySettings(defaults: defaults)
		#expect(restoredDarkGray.theme == .darkGray)

		restoredDarkGray.reset()
		#expect(restoredDarkGray.theme == .system)
		#expect(defaults.string(forKey: "pigeon.reader.theme") == "system")
	}

	@Test
	func splitViewReaderDoesNotPreferAWindowColorScheme() {
		#expect(ReaderTheme.system.preferredColorScheme == nil)
		#expect(ReaderTheme.light.preferredColorScheme == .light)
		#expect(ReaderTheme.sepia.preferredColorScheme == .light)
		#expect(ReaderTheme.darkGray.preferredColorScheme == .dark)
		#expect(ReaderTheme.dark.preferredColorScheme == .dark)

		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .sepia, isCompactReader: false) == .environmentOnly(.light))
		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .light, isCompactReader: false) == .environmentOnly(.light))
		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .dark, isCompactReader: false) == .environmentOnly(.dark))
		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .darkGray, isCompactReader: false) == .environmentOnly(.dark))
		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .system, isCompactReader: false) == .inheritSystem)
		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .sepia, isCompactReader: false).usesPreferredColorScheme == false)
		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .dark, isCompactReader: false).usesPreferredColorScheme == false)
	}

	@Test
	func compactReaderMayPreferAWindowColorScheme() {
		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .sepia, isCompactReader: true) == .preferredColorScheme(.light))
		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .dark, isCompactReader: true) == .preferredColorScheme(.dark))
		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .system, isCompactReader: true) == .inheritSystem)
		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .sepia, isCompactReader: true).usesPreferredColorScheme)
		#expect(ReaderThemeColorSchemePlacement.resolve(theme: .system, isCompactReader: true).usesPreferredColorScheme == false)
	}
}
