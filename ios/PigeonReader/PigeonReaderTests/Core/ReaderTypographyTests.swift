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

	@Test(arguments: [
		"Allo-Regular",
		"Allo-SemiBold",
		"Allo-Bold",
		"Allo-Oblique",
		"Allo-BoldOblique",
	])
	func bundledAlloFaceIsRegistered(postScriptName: String) {
		let font = UIFont(name: postScriptName, size: 17)
		#expect(font?.familyName == "Allo")
	}

	@Test func bundledGeistSerifIsRegistered() {
		let font = UIFont(name: "GeistSerif-Regular", size: 17)
		#expect(font?.familyName == "Geist Serif")
	}

	@Test(arguments: ReaderTypeface.allCases)
	func everyTypefaceNamesBundledFaces(typeface: ReaderTypeface) {
		for name in [typeface.regularFontName, typeface.titleFontName, typeface.italicFontName] {
			#expect(UIFont(name: name, size: 17) != nil, "\(typeface) uses \(name)")
		}
	}

	@Test func geistSerifSetsTitlesAndItalicsInItsOnlyFace() {
		#expect(ReaderTypeface.geistSerif.titleFontName == "GeistSerif-Regular")
		#expect(ReaderTypeface.geistSerif.italicFontName == "GeistSerif-Regular")
		#expect(ReaderTypeface.bookerly.titleFontName == "Bookerly-Bold")
		#expect(ReaderTypeface.bookerly.italicFontName == "Bookerly-Italic")
		#expect(ReaderTypeface.allo.titleFontName == "Allo-SemiBold")
		#expect(ReaderTypeface.allo.italicFontName == "Allo-Oblique")
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
