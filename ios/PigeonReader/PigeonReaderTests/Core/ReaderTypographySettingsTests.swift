import Foundation
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
		#expect(settings.textScale == ReaderTypographySettings.textScaleRange.upperBound)
		#expect(settings.lineHeight == ReaderTypographySettings.lineHeightRange.lowerBound)
		#expect(defaults.double(forKey: "pigeon.reader.typography.text-scale") == ReaderTypographySettings.textScaleRange.upperBound)
		#expect(defaults.double(forKey: "pigeon.reader.typography.line-height") == ReaderTypographySettings.lineHeightRange.lowerBound)

		settings.reset()
		#expect(settings.textScale == ReaderTypographySettings.defaultTextScale)
		#expect(settings.lineHeight == ReaderTypographySettings.defaultLineHeight)
	}
}
