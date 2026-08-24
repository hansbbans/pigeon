import SwiftUI

enum ReaderTypography {
	static let storyTitle = Font.custom("Bookerly-Bold", size: 17, relativeTo: .body)
	static let articleTitlePointSize = 25.0
	static let articleBodyPointSize = 18.0

	static func articleTitle(textScale: Double) -> Font {
		Font.custom("Bookerly-Bold", size: scaledPointSize(articleTitlePointSize, textScale: textScale), relativeTo: .title)
	}

	static func articleBody(textScale: Double) -> Font {
		Font.custom("Bookerly-Regular", size: scaledPointSize(articleBodyPointSize, textScale: textScale), relativeTo: .body)
	}

	static func scaledPointSize(_ base: Double, textScale: Double) -> Double {
		base * clampedTextScale(textScale)
	}

	static func clampedTextScale(_ textScale: Double) -> Double {
		min(max(textScale, ReaderTypographySettings.textScaleRange.lowerBound), ReaderTypographySettings.textScaleRange.upperBound)
	}
}
