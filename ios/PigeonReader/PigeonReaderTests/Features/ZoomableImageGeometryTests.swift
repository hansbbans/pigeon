import CoreGraphics
import Testing
@testable import PigeonReader

struct ZoomableImageGeometryTests {
	@Test func rotationPreservesTheOldViewportCenterWithoutCountingOffsetTwice() {
		let ratio = ZoomableImageGeometry.visibleCenterRatio(
			offset: CGPoint(x: 100, y: 240),
			viewport: CGSize(width: 400, height: 800),
			content: CGSize(width: 1000, height: 1600)
		)
		#expect(ratio == CGPoint(x: 0.3, y: 0.4))
	}

	@Test
	func fitsLandscapeImageInsidePortraitViewport() {
		#expect(
			ZoomableImageGeometry.fittedSize(
				imageSize: CGSize(width: 1_600, height: 900),
				in: CGSize(width: 390, height: 844),
			) == CGSize(width: 390, height: 219.375),
		)
	}

	@Test
	func fitsPortraitImageInsideLandscapeViewport() {
		#expect(
			ZoomableImageGeometry.fittedSize(
				imageSize: CGSize(width: 900, height: 1_600),
				in: CGSize(width: 844, height: 390),
			) == CGSize(width: 219.375, height: 390),
		)
	}

	@Test
	func rejectsInvalidSizesAndCentersSmallContent() {
		#expect(
			ZoomableImageGeometry.fittedSize(
				imageSize: CGSize(width: 0, height: 100),
				in: CGSize(width: 390, height: 844),
			) == .zero,
		)
		#expect(
			ZoomableImageGeometry.centeringInset(
				viewportSize: CGSize(width: 390, height: 844),
				contentSize: CGSize(width: 240, height: 120),
			) == CGSize(width: 75, height: 362),
		)
	}
}
