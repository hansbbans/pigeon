import SwiftUI
import UIKit

@MainActor
final class ZoomableImageScrollViewCoordinator: NSObject, UIScrollViewDelegate {
	private let zoomContainer = UIView()
	private let imageView = UIImageView()
	private weak var scrollView: ZoomableImageUIScrollView?
	private var image: UIImage?
	private var reduceMotion = false
	private var baseImageSize = CGSize.zero
	private var previousViewportSize = CGSize.zero
	private var isLayingOut = false
	private var zoomScaleBinding: Binding<CGFloat>
	private var lastAppliedExternalScale = ZoomableImageInteraction.minimumZoomScale
	private var lastReportedScale = ZoomableImageInteraction.minimumZoomScale
	private var pendingZoomReport: CGFloat?
	private var zoomReportTask: Task<Void, Never>?
	private var dragStartedFitted = false
	var onDismiss: () -> Void

	private lazy var doubleTapGesture: UITapGestureRecognizer = {
		let gesture = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
		gesture.numberOfTapsRequired = 2
		gesture.cancelsTouchesInView = false
		return gesture
	}()

	init(zoomScale: Binding<CGFloat>, onDismiss: @escaping () -> Void) {
		zoomScaleBinding = zoomScale
		self.onDismiss = onDismiss
		super.init()
	}

	func configure(
		_scrollView: ZoomableImageUIScrollView,
		image: UIImage,
		reduceMotion: Bool,
	) {
		self.scrollView = _scrollView
		self.reduceMotion = reduceMotion

		_scrollView.delegate = self
		_scrollView.backgroundColor = .black
		_scrollView.contentInsetAdjustmentBehavior = .never
		_scrollView.alwaysBounceHorizontal = true
		_scrollView.alwaysBounceVertical = true
		_scrollView.bouncesZoom = true
		_scrollView.maximumZoomScale = ZoomableImageInteraction.maximumZoomScale
		_scrollView.minimumZoomScale = ZoomableImageInteraction.minimumZoomScale
		_scrollView.showsHorizontalScrollIndicator = false
		_scrollView.showsVerticalScrollIndicator = false
		_scrollView.accessibilityIdentifier = "zoomable-image-scroll-view"
		_scrollView.accessibilityLabel = "Article image"
		_scrollView.accessibilityHint = "Double-tap to zoom. Use two fingers to pan."
		_scrollView.accessibilityTraits = [.image]

		if zoomContainer.superview !== _scrollView {
			_scrollView.addSubview(zoomContainer)
			_scrollView.addGestureRecognizer(doubleTapGesture)
		}
		if imageView.superview !== zoomContainer {
			zoomContainer.addSubview(imageView)
		}
		imageView.contentMode = .scaleAspectFit
		imageView.isUserInteractionEnabled = true
		imageView.isAccessibilityElement = false

		if self.image !== image {
			self.image = image
			imageView.image = image
			baseImageSize = .zero
			previousViewportSize = .zero
		}
		_scrollView.onLayout = { [weak self, weak _scrollView] in
			guard let self, let _scrollView else { return }
			self.layoutImage(in: _scrollView)
		}
		layoutImage(in: _scrollView)
		updatePanGestureRecognizer(in: _scrollView)
	}

	func update(
		_scrollView: ZoomableImageUIScrollView,
		image: UIImage,
		reduceMotion: Bool,
		requestedZoomScale: CGFloat,
	) {
		self.reduceMotion = reduceMotion
		if self.image !== image {
			self.image = image
			imageView.image = image
			baseImageSize = .zero
			previousViewportSize = .zero
		}
		layoutImage(in: _scrollView)

		let requestedScale = ZoomableImageInteraction.clampedZoomScale(requestedZoomScale)
		updatePanGestureRecognizer(in: _scrollView, zoomScale: requestedScale)
		guard abs(requestedScale - lastAppliedExternalScale) > 0.001 else { return }
		lastAppliedExternalScale = requestedScale
		zoomReportTask?.cancel()
		zoomReportTask = nil
		pendingZoomReport = nil
		guard abs(_scrollView.zoomScale - requestedScale) > 0.001 else { return }
		_scrollView.setZoomScale(requestedScale, animated: reduceMotion == false)
	}

	func tearDown() {
		zoomReportTask?.cancel()
		zoomReportTask = nil
		pendingZoomReport = nil
		scrollView?.onLayout = nil
		scrollView?.delegate = nil
		scrollView?.removeGestureRecognizer(doubleTapGesture)
		scrollView = nil
	}

	func viewForZooming(in scrollView: UIScrollView) -> UIView? {
		zoomContainer
	}

	func scrollViewDidZoom(_ scrollView: UIScrollView) {
		updateCenteringInsets(in: scrollView)
		updatePanGestureRecognizer(in: scrollView)
		reportZoomScale(scrollView.zoomScale)
	}

	func scrollViewDidEndZooming(
		_ scrollView: UIScrollView,
		with view: UIView?,
		atScale scale: CGFloat,
	) {
		updateCenteringInsets(in: scrollView)
		updatePanGestureRecognizer(in: scrollView)
		reportZoomScale(scale)
	}

	func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
		dragStartedFitted = ZoomableImageInteraction.canDismissSheet(at: scrollView.zoomScale)
	}

	func scrollViewWillEndDragging(
		_ scrollView: UIScrollView,
		withVelocity velocity: CGPoint,
		targetContentOffset: UnsafeMutablePointer<CGPoint>,
	) {
		guard dragStartedFitted else { return }
		dragStartedFitted = false
		let pan = scrollView.panGestureRecognizer
		guard ZoomableImageInteraction.shouldDismissAfterDrag(
			translation: pan.translation(in: scrollView),
			velocity: pan.velocity(in: scrollView),
			zoomScale: scrollView.zoomScale,
		) else { return }
		onDismiss()
	}

	private func updatePanGestureRecognizer(in scrollView: UIScrollView, zoomScale: CGFloat? = nil) {
		// The image follows a fitted downward pull using native scroll bounce.
		// Its centered content inset prevents the sheet from taking over this
		// gesture, so the delegate completes dismissal after a deliberate pull.
		scrollView.alwaysBounceVertical = true
		scrollView.alwaysBounceHorizontal = ZoomableImageInteraction.canPanImage(
			at: zoomScale ?? scrollView.zoomScale,
		)
	}

	private func layoutImage(in scrollView: ZoomableImageUIScrollView) {
		guard isLayingOut == false, let image, scrollView.bounds.width > 0, scrollView.bounds.height > 0 else {
			return
		}

		isLayingOut = true
		defer { isLayingOut = false }

		let viewportSize = scrollView.bounds.size
		let fittedSize = ZoomableImageGeometry.fittedSize(
			imageSize: image.size,
			in: viewportSize,
		)
		guard fittedSize != .zero else { return }

		let viewportChanged = previousViewportSize != viewportSize
		let imageChanged = baseImageSize != fittedSize
		guard viewportChanged || imageChanged || baseImageSize == .zero else {
			updateCenteringInsets(in: scrollView)
			return
		}

		let oldScale = ZoomableImageInteraction.clampedZoomScale(scrollView.zoomScale)
		let oldContentSize = scrollView.contentSize
		let oldCenterRatio = ZoomableImageGeometry.visibleCenterRatio(
			offset: scrollView.contentOffset,
			viewport: previousViewportSize == .zero ? viewportSize : previousViewportSize,
			content: oldContentSize,
		)

		if oldScale > ZoomableImageInteraction.minimumZoomScale {
			scrollView.setZoomScale(ZoomableImageInteraction.minimumZoomScale, animated: false)
		}

		baseImageSize = fittedSize
		previousViewportSize = viewportSize
		zoomContainer.frame = CGRect(origin: .zero, size: fittedSize)
		imageView.frame = zoomContainer.bounds
		scrollView.contentSize = fittedSize

		if oldScale > ZoomableImageInteraction.minimumZoomScale {
			scrollView.setZoomScale(oldScale, animated: false)
		}
		updateCenteringInsets(in: scrollView)

		if oldScale > ZoomableImageInteraction.minimumZoomScale {
			let newContentSize = scrollView.contentSize
			let targetCenter = CGPoint(
				x: oldCenterRatio.x * newContentSize.width,
				y: oldCenterRatio.y * newContentSize.height,
			)
			scrollView.setContentOffset(clampedContentOffset(
				for: targetCenter,
				in: scrollView,
			), animated: false)
		} else {
			scrollView.setContentOffset(
				CGPoint(x: -scrollView.contentInset.left, y: -scrollView.contentInset.top),
				animated: false,
			)
			reportZoomScale(ZoomableImageInteraction.minimumZoomScale)
		}
	}

	private func updateCenteringInsets(in scrollView: UIScrollView) {
		let inset = ZoomableImageGeometry.centeringInset(
			viewportSize: scrollView.bounds.size,
			contentSize: scrollView.contentSize,
		)
		let newInsets = UIEdgeInsets(top: inset.height, left: inset.width, bottom: inset.height, right: inset.width)
		if scrollView.contentInset != newInsets {
			scrollView.contentInset = newInsets
			scrollView.scrollIndicatorInsets = newInsets
		}
	}

	private func reportZoomScale(_ scale: CGFloat) {
		let clampedScale = ZoomableImageInteraction.clampedZoomScale(scale)
		guard abs(lastReportedScale - clampedScale) > 0.001 else { return }
		lastReportedScale = clampedScale
		pendingZoomReport = clampedScale
		zoomReportTask?.cancel()
		zoomReportTask = Task { @MainActor [weak self] in
			await Task.yield()
			guard let self, Task.isCancelled == false,
				let pendingZoomReport = self.pendingZoomReport else {
				return
			}
			self.pendingZoomReport = nil
			self.zoomReportTask = nil
			// The next SwiftUI update echoes this native gesture, rather than
			// requesting a new zoom that would interrupt the current animation.
			self.lastAppliedExternalScale = pendingZoomReport
			guard abs(self.zoomScaleBinding.wrappedValue - pendingZoomReport) > 0.001 else { return }
			self.zoomScaleBinding.wrappedValue = pendingZoomReport
		}
	}

	private func clampedContentOffset(for contentCenter: CGPoint, in scrollView: UIScrollView) -> CGPoint {
		let proposed = CGPoint(
			x: contentCenter.x - scrollView.bounds.width / 2,
			y: contentCenter.y - scrollView.bounds.height / 2,
		)
		let minimumX = -scrollView.contentInset.left
		let minimumY = -scrollView.contentInset.top
		let maximumX = max(
			minimumX,
			scrollView.contentSize.width - scrollView.bounds.width + scrollView.contentInset.right,
		)
		let maximumY = max(
			minimumY,
			scrollView.contentSize.height - scrollView.bounds.height + scrollView.contentInset.bottom,
		)
		return CGPoint(
			x: min(max(proposed.x, minimumX), maximumX),
			y: min(max(proposed.y, minimumY), maximumY),
		)
	}

	@objc private func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
		guard let scrollView, image != nil else { return }
		let minimumScale = ZoomableImageInteraction.minimumZoomScale
		let currentScale = ZoomableImageInteraction.clampedZoomScale(scrollView.zoomScale)
		if currentScale > minimumScale + 0.001 {
			updatePanGestureRecognizer(in: scrollView, zoomScale: minimumScale)
			scrollView.setZoomScale(minimumScale, animated: reduceMotion == false)
			return
		}

		let targetScale = ZoomableImageInteraction.clampedZoomScale(
			ZoomableImageInteraction.doubleTapZoomScale,
		)
		let tapPoint = gesture.location(in: zoomContainer)
		let zoomSize = CGSize(
			width: scrollView.bounds.width / targetScale,
			height: scrollView.bounds.height / targetScale,
		)
		let bounds = zoomContainer.bounds
		let origin = CGPoint(
			x: min(max(tapPoint.x - zoomSize.width / 2, bounds.minX), max(bounds.maxX - zoomSize.width, bounds.minX)),
			y: min(max(tapPoint.y - zoomSize.height / 2, bounds.minY), max(bounds.maxY - zoomSize.height, bounds.minY)),
		)
		updatePanGestureRecognizer(in: scrollView, zoomScale: targetScale)
		scrollView.zoom(to: CGRect(origin: origin, size: zoomSize), animated: reduceMotion == false)
	}
}
