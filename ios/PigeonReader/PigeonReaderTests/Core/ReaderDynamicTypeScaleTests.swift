import SwiftUI
import Testing
@testable import PigeonReader

struct ReaderDynamicTypeScaleTests {
	@Test
	func largerDynamicTypeIncreasesRenderingScaleWithoutDiscardingManualMultiplier() {
		let manualTextScale = 1.2
		let defaultScale = ReaderDynamicTypeScale.effectiveTextScale(
			manualTextScale: manualTextScale,
			dynamicTypeSize: .large,
		)
		let accessibilityScale = ReaderDynamicTypeScale.effectiveTextScale(
			manualTextScale: manualTextScale,
			dynamicTypeSize: .accessibility3,
		)

		#expect(defaultScale == 1.2)
		#expect(accessibilityScale > defaultScale)
		#expect(accessibilityScale == manualTextScale * ReaderDynamicTypeScale.value(for: .accessibility3))
	}

	@Test
	func manualAndDynamicTypeScalesStayWithinSensibleBounds() {
		#expect(ReaderDynamicTypeScale.effectiveTextScale(manualTextScale: 0, dynamicTypeSize: .xSmall) == ReaderDynamicTypeScale.renderedTextScaleRange.lowerBound)
		#expect(ReaderDynamicTypeScale.effectiveTextScale(manualTextScale: 99, dynamicTypeSize: .accessibility5) == ReaderDynamicTypeScale.renderedTextScaleRange.upperBound)
	}
}
