import Testing
import UIKit
@testable import PigeonReader

struct ReaderTypographyTests {
	@Test(arguments: [
		"Bookerly-Regular",
		"Bookerly-Bold",
		"Bookerly-Italic",
		"Bookerly-BoldItalic",
	])
	func bundledBookerlyFaceIsRegistered(postScriptName: String) {
		#expect(UIFont(name: postScriptName, size: 17) != nil)
	}

	@Test func articleTitleAndFallbackBodyScaleWithReadingTextSize() {
		#expect(ReaderTypography.scaledPointSize(ReaderTypography.articleTitlePointSize, textScale: 1) == 25)
		#expect(ReaderTypography.scaledPointSize(ReaderTypography.articleTitlePointSize, textScale: 1.2) == 30)
		#expect(abs(ReaderTypography.scaledPointSize(ReaderTypography.articleBodyPointSize, textScale: 0.85) - 15.3) < 0.000_001)
		#expect(
			ReaderTypography.scaledPointSize(ReaderTypography.articleTitlePointSize, textScale: 10)
				== ReaderTypography.articleTitlePointSize * ReaderTypographySettings.textScaleRange.upperBound
		)
		#expect(
			ReaderTypography.scaledPointSize(ReaderTypography.articleBodyPointSize, textScale: 0)
				== ReaderTypography.articleBodyPointSize * ReaderTypographySettings.textScaleRange.lowerBound
		)
	}

	@Test func readingTextScaleClampMatchesSettingsBounds() {
		#expect(ReaderTypography.clampedTextScale(ReaderTypographySettings.defaultTextScale) == 1)
		#expect(ReaderTypography.clampedTextScale(1.35) == ReaderTypographySettings.textScaleRange.upperBound)
		#expect(ReaderTypography.clampedTextScale(0.85) == ReaderTypographySettings.textScaleRange.lowerBound)
	}
}
