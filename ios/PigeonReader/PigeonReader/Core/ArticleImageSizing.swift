import CoreGraphics

enum ArticleImageSizing {
	static func displayedSize(imageSize: CGSize, columnWidth: CGFloat) -> CGSize {
		guard imageSize.width.isFinite, imageSize.height.isFinite,
			imageSize.width > 0, imageSize.height > 0,
			columnWidth.isFinite, columnWidth > 0 else {
			return .zero
		}

		let width = min(imageSize.width, columnWidth)
		return CGSize(width: width, height: width * imageSize.height / imageSize.width)
	}
}
