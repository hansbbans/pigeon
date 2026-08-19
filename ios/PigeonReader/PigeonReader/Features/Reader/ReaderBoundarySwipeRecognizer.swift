import SwiftUI
import UIKit

/// Installs a simultaneous pan recognizer on the native scroll view that owns
/// the reader content. Attaching to the scroll view keeps the gesture observable
/// when a tall, non-scrolling WKWebView is under the user's finger.
struct ReaderBoundarySwipeRecognizer: UIViewRepresentable {
	let boundaryState: () -> ReaderBoundaryNavigationState
	let onSwipe: (ReaderBoundaryNavigationState, CGFloat, CGFloat) -> Void
	var onBackSwipe: (() -> Void)?

	func makeCoordinator() -> Coordinator {
		Coordinator(boundaryState: boundaryState, onSwipe: onSwipe, onBackSwipe: onBackSwipe)
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
		context.coordinator.onBackSwipe = onBackSwipe
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
		var onBackSwipe: (() -> Void)?
		private weak var attachedScrollView: UIScrollView?
		private var boundaryAtStart: ReaderBoundaryNavigationState?
		private var startX: CGFloat?

		private lazy var panGesture: UIPanGestureRecognizer = {
			let gesture = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
			gesture.cancelsTouchesInView = false
			gesture.delegate = self
			return gesture
		}()

		init(
			boundaryState: @escaping () -> ReaderBoundaryNavigationState,
			onSwipe: @escaping (ReaderBoundaryNavigationState, CGFloat, CGFloat) -> Void,
			onBackSwipe: (() -> Void)?,
		) {
			self.boundaryState = boundaryState
			self.onSwipe = onSwipe
			self.onBackSwipe = onBackSwipe
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
			startX = nil
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
				startX = gesture.location(in: gesture.view).x
			case .ended:
				defer {
					boundaryAtStart = nil
					startX = nil
				}
				guard let view = gesture.view else { return }
				let translation = gesture.translation(in: view)
				if let startX, ReaderBoundaryNavigation.isBackToFeedSwipe(
					startX: Double(startX),
					translationX: Double(translation.x),
					translationY: Double(translation.y),
				) {
					onBackSwipe?()
					return
				}
				guard let boundaryAtStart else { return }
				onSwipe(boundaryAtStart, translation.x, translation.y)
			case .cancelled, .failed:
				boundaryAtStart = nil
				startX = nil
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

/// A screen-edge pan that returns from a restored article to the feed list.
///
/// Hiding the system back button also disables interactive pop. Restoring
/// NavigationSplitView to `.detail` on iPhone has no stack to pop, so this
/// recognizer drives `showFeedColumn()` instead.
struct ReaderBackSwipeRecognizer: UIViewRepresentable {
	let onBack: () -> Void

	func makeCoordinator() -> Coordinator {
		Coordinator(onBack: onBack)
	}

	func makeUIView(context: Context) -> ReaderBoundarySwipeRecognizer.AttachmentView {
		let view = ReaderBoundarySwipeRecognizer.AttachmentView()
		view.isUserInteractionEnabled = false
		view.hierarchyChanged = { [weak coordinator = context.coordinator, weak view] in
			guard let view else { return }
			coordinator?.scheduleAttachment(from: view)
		}
		return view
	}

	func updateUIView(_ uiView: ReaderBoundarySwipeRecognizer.AttachmentView, context: Context) {
		context.coordinator.onBack = onBack
		context.coordinator.scheduleAttachment(from: uiView)
	}

	static func dismantleUIView(
		_ uiView: ReaderBoundarySwipeRecognizer.AttachmentView,
		coordinator: Coordinator,
	) {
		uiView.hierarchyChanged = nil
		coordinator.detach()
	}

	final class Coordinator: NSObject, UIGestureRecognizerDelegate {
		var onBack: () -> Void
		private weak var attachedView: UIView?

		private lazy var edgeGesture: UIScreenEdgePanGestureRecognizer = {
			let gesture = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdge(_:)))
			gesture.edges = .left
			gesture.cancelsTouchesInView = false
			gesture.delegate = self
			return gesture
		}()

		init(onBack: @escaping () -> Void) {
			self.onBack = onBack
		}

		func scheduleAttachment(from view: UIView) {
			DispatchQueue.main.async { [weak self, weak view] in
				guard let self, let view else { return }
				self.attach(to: view.superview ?? view.window)
			}
		}

		func detach() {
			attachedView?.removeGestureRecognizer(edgeGesture)
			attachedView = nil
		}

		private func attach(to view: UIView?) {
			guard attachedView !== view else { return }
			detach()
			guard let view else { return }
			view.addGestureRecognizer(edgeGesture)
			attachedView = view
		}

		@objc private func handleEdge(_ gesture: UIScreenEdgePanGestureRecognizer) {
			guard gesture.state == .ended, let view = gesture.view else { return }
			let translation = gesture.translation(in: view)
			if ReaderBoundaryNavigation.isBackToFeedSwipe(
				startX: 0,
				translationX: Double(translation.x),
				translationY: Double(translation.y),
			) {
				onBack()
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
