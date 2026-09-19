import SwiftUI
import UIKit

struct ZoomableImageScrollView: UIViewRepresentable {
	let image: UIImage
	@Binding var zoomScale: CGFloat
	let reduceMotion: Bool
	let onDismiss: () -> Void

	func makeCoordinator() -> ZoomableImageScrollViewCoordinator {
		ZoomableImageScrollViewCoordinator(zoomScale: _zoomScale, onDismiss: onDismiss)
	}

	func makeUIView(context: Context) -> ZoomableImageUIScrollView {
		let scrollView = ZoomableImageUIScrollView()
		context.coordinator.configure(
			_scrollView: scrollView,
			image: image,
			reduceMotion: reduceMotion,
		)
		return scrollView
	}

	func updateUIView(_ scrollView: ZoomableImageUIScrollView, context: Context) {
		context.coordinator.onDismiss = onDismiss
		context.coordinator.update(
			_scrollView: scrollView,
			image: image,
			reduceMotion: reduceMotion,
			requestedZoomScale: zoomScale,
		)
	}

	static func dismantleUIView(
		_ scrollView: ZoomableImageUIScrollView,
		coordinator: ZoomableImageScrollViewCoordinator,
	) {
		coordinator.tearDown()
	}
}
