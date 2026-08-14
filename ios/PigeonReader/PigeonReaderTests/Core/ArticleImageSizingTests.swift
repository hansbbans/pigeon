import CoreGraphics
import Testing
@testable import PigeonReader

struct ArticleImageSizingTests {
	@Test
	func neverUpscalesSmallImagesAndCapsLargeImagesToTheColumn() {
		#expect(ArticleImageSizing.displayedSize(
			imageSize: CGSize(width: 240, height: 120),
			columnWidth: 640,
		) == CGSize(width: 240, height: 120))
		#expect(ArticleImageSizing.displayedSize(
			imageSize: CGSize(width: 1_280, height: 640),
			columnWidth: 640,
		) == CGSize(width: 640, height: 320))
	}

	@Test
	func rejectsInvalidIntrinsicDimensions() {
		#expect(ArticleImageSizing.displayedSize(
			imageSize: CGSize(width: 0, height: 120),
			columnWidth: 640,
		) == .zero)
		#expect(ArticleImageSizing.displayedSize(
			imageSize: CGSize(width: 240, height: 120),
			columnWidth: 0,
		) == .zero)
	}
}
