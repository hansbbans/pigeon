import CoreGraphics
import Testing
@testable import PigeonReader

struct ZoomableImageInteractionTests {
	@Test
	func clampsInvalidAndOutOfRangeScales() {
		#expect(ZoomableImageInteraction.clampedZoomScale(.nan) == 1)
		#expect(ZoomableImageInteraction.clampedZoomScale(-2) == 1)
		#expect(ZoomableImageInteraction.clampedZoomScale(3) == 3)
		#expect(ZoomableImageInteraction.clampedZoomScale(20) == 5)
	}

	@Test
	func sheetCanDismissOnlyWhenImageIsZoomedOut() {
		#expect(ZoomableImageInteraction.canDismissSheet(at: 1))
		#expect(ZoomableImageInteraction.canDismissSheet(at: 1.01))
		#expect(ZoomableImageInteraction.canDismissSheet(at: 1.02) == false)
		#expect(ZoomableImageInteraction.canDismissSheet(at: 4) == false)
	}

	@Test
	func imagePanIsReservedForZoomedContent() {
		#expect(ZoomableImageInteraction.canPanImage(at: 1) == false)
		#expect(ZoomableImageInteraction.canPanImage(at: 1.01) == false)
		#expect(ZoomableImageInteraction.canPanImage(at: 1.02))
		#expect(ZoomableImageInteraction.canPanImage(at: 4))
	}

	@Test
	func dismissalRequiresADeliberateDownwardPullAtFittedSize() {
		#expect(ZoomableImageInteraction.shouldDismissAfterDrag(translation: CGPoint(x: 5, y: 120), velocity: .zero, zoomScale: 1))
		#expect(ZoomableImageInteraction.shouldDismissAfterDrag(translation: CGPoint(x: 0, y: 40), velocity: CGPoint(x: 0, y: 900), zoomScale: 1))
		#expect(ZoomableImageInteraction.shouldDismissAfterDrag(translation: CGPoint(x: 0, y: 40), velocity: .zero, zoomScale: 1) == false)
		#expect(ZoomableImageInteraction.shouldDismissAfterDrag(translation: CGPoint(x: 150, y: 120), velocity: .zero, zoomScale: 1) == false)
		#expect(ZoomableImageInteraction.shouldDismissAfterDrag(translation: CGPoint(x: 0, y: 120), velocity: CGPoint(x: 0, y: -100), zoomScale: 1) == false)
		#expect(ZoomableImageInteraction.shouldDismissAfterDrag(translation: CGPoint(x: 0, y: 120), velocity: .zero, zoomScale: 2) == false)
	}

	@Test
	func voiceOverZoomAdjustmentsStayWithinBounds() {
		#expect(ZoomableImageInteraction.accessibilityIncrement(from: 1) == 1.5)
		#expect(ZoomableImageInteraction.accessibilityIncrement(from: 4) == 5)
		#expect(ZoomableImageInteraction.accessibilityDecrement(from: 1) == 1)
		#expect(ZoomableImageInteraction.accessibilityDecrement(from: 3) == 2)
	}
}
