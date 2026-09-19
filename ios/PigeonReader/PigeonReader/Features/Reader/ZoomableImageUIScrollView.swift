import UIKit

@MainActor
final class ZoomableImageUIScrollView: UIScrollView {
	var onLayout: (() -> Void)?

	override func layoutSubviews() {
		super.layoutSubviews()
		onLayout?()
	}
}
