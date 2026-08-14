import SwiftUI

enum ReaderDynamicTypeScale {
	static let renderedTextScaleRange = 0.72...3.0

	static func value(for dynamicTypeSize: DynamicTypeSize) -> Double {
		switch dynamicTypeSize {
		case .xSmall:
			return 0.82
		case .small:
			return 0.90
		case .medium:
			return 0.96
		case .large:
			return 1.0
		case .xLarge:
			return 1.10
		case .xxLarge:
			return 1.22
		case .xxxLarge:
			return 1.36
		case .accessibility1:
			return 1.55
		case .accessibility2:
			return 1.76
		case .accessibility3:
			return 1.98
		case .accessibility4:
			return 2.20
		case .accessibility5:
			return 2.42
		@unknown default:
			return 1.0
		}
	}

	static func effectiveTextScale(manualTextScale: Double, dynamicTypeSize: DynamicTypeSize) -> Double {
		let manual = min(max(manualTextScale, ReaderTypographySettings.textScaleRange.lowerBound), ReaderTypographySettings.textScaleRange.upperBound)
		let combined = manual * value(for: dynamicTypeSize)
		return min(max(combined, renderedTextScaleRange.lowerBound), renderedTextScaleRange.upperBound)
	}
}
