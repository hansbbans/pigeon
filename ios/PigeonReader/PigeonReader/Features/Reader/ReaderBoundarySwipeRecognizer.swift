import SwiftUI
import UIKit

/// Installs a simultaneous pan recognizer on the native scroll view that owns
/// the reader content. Attaching to the scroll view keeps the gesture observable
/// when a tall, non-scrolling WKWebView is under the user's finger.
struct ReaderBoundarySwipeRecognizer: UIViewRepresentable {
	let boundaryState: () -> ReaderBoundaryNavigationState
	let onSwipe: (ReaderBoundaryNavigationState, CGFloat, CGFloat) -> Void

	func makeCoordinator() -> Coordinator {
		Coordinator(boundaryState: boundaryState, onSwipe: onSwipe)
	}

	func makeUIView(context: Context) -> AttachmentView {
		let view = AttachmentView()
		view.isUserInteractionEnabled = false
		view.hierarchyChanged = { [weak coordinator = context.coordinator, weak view] in
			guard let view else { return }
			coordinator?.scheduleAttachment(from: view)
		}
		return view
	}

	func updateUIView(_ uiView: AttachmentView, context: Context) {
		context.coordinator.boundaryState = boundaryState
		context.coordinator.onSwipe = onSwipe
		context.coordinator.scheduleAttachment(from: uiView)
	}

	static func dismantleUIView(_ uiView: AttachmentView, coordinator: Coordinator) {
		uiView.hierarchyChanged = nil
		coordinator.detach()
	}

	final class AttachmentView: UIView {
		var hierarchyChanged: (() -> Void)?

		override func didMoveToSuperview() {
			super.didMoveToSuperview()
			hierarchyChanged?()
		}

		override func didMoveToWindow() {
			super.didMoveToWindow()
			hierarchyChanged?()
		}
	}

	final class Coordinator: NSObject, UIGestureRecognizerDelegate {
		var boundaryState: () -> ReaderBoundaryNavigationState
		var onSwipe: (ReaderBoundaryNavigationState, CGFloat, CGFloat) -> Void
		private weak var attachedScrollView: UIScrollView?
		private var boundaryAtStart: ReaderBoundaryNavigationState?

		private lazy var panGesture: UIPanGestureRecognizer = {
			let gesture = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
			gesture.cancelsTouchesInView = false
			gesture.delegate = self
			return gesture
		}()

		init(
			boundaryState: @escaping () -> ReaderBoundaryNavigationState,
			onSwipe: @escaping (ReaderBoundaryNavigationState, CGFloat, CGFloat) -> Void,
		) {
			self.boundaryState = boundaryState
			self.onSwipe = onSwipe
		}

		func scheduleAttachment(from view: UIView) {
			DispatchQueue.main.async { [weak self, weak view] in
				guard let self, let view else { return }
				self.attach(to: view.firstAncestor(of: UIScrollView.self))
			}
		}

		func detach() {
			attachedScrollView?.removeGestureRecognizer(panGesture)
			attachedScrollView = nil
			boundaryAtStart = nil
		}

		private func attach(to scrollView: UIScrollView?) {
			guard attachedScrollView !== scrollView else { return }
			detach()
			guard let scrollView else { return }
			scrollView.addGestureRecognizer(panGesture)
			attachedScrollView = scrollView
		}

		@objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
			switch gesture.state {
			case .began:
				boundaryAtStart = boundaryState()
			case .ended:
				defer { boundaryAtStart = nil }
				guard let boundaryAtStart, let view = gesture.view else { return }
				let translation = gesture.translation(in: view)
				onSwipe(boundaryAtStart, translation.x, translation.y)
			case .cancelled, .failed:
				boundaryAtStart = nil
			default:
				break
			}
		}

		func gestureRecognizer(
			_ gestureRecognizer: UIGestureRecognizer,
			shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer,
		) -> Bool {
			true
		}
	}
}

private extension UIView {
	func firstAncestor<T: UIView>(of type: T.Type) -> T? {
		var candidate = superview
		while let view = candidate {
			if let match = view as? T {
				return match
			}
			candidate = view.superview
		}
		return nil
	}
}
