import SwiftUI
import UIKit

@MainActor
final class ReaderSidebarNativeScrollViewProxy {
	private weak var scrollView: UIScrollView?
	private var owners: Set<ObjectIdentifier> = []

	func attach(_ scrollView: UIScrollView, owner: ObjectIdentifier) {
		self.scrollView = scrollView
		owners.insert(owner)
	}

	func detach(owner: ObjectIdentifier) {
		owners.remove(owner)
		if owners.isEmpty {
			self.scrollView = nil
		}
	}

	@discardableResult
	func apply(_ plan: ReaderSidebarViewportCollapsePlan, animated: Bool) -> Bool {
		guard let scrollView else { return false }
		let minimum = -scrollView.adjustedContentInset.top
		let maximum = max(
			minimum,
			scrollView.contentSize.height
				- scrollView.bounds.height
				+ scrollView.adjustedContentInset.bottom,
		)
		let targetOffsetY = min(max(plan.targetOffsetY, minimum), maximum)
		guard abs(targetOffsetY - scrollView.contentOffset.y) > ReaderSidebarViewportAnchor.geometryTolerance else {
			return true
		}
		scrollView.setContentOffset(
			CGPoint(x: scrollView.contentOffset.x, y: targetOffsetY),
			animated: animated,
		)
		return true
	}
}

/// Finds the native scroll view backing the sidebar List so a folder collapse
/// can apply a bounded pixel correction without replacing SwiftUI's List or
/// its native scrolling behavior.
struct ReaderSidebarScrollViewAnchor: UIViewRepresentable {
	let proxy: ReaderSidebarNativeScrollViewProxy

	func makeUIView(context: Context) -> AnchorView {
		let view = AnchorView()
		view.proxy = proxy
		return view
	}

	func updateUIView(_ view: AnchorView, context: Context) {
		view.proxy = proxy
		view.attachIfPossible()
	}

	static func dismantleUIView(_ view: AnchorView, coordinator: ()) {
		view.detach()
		view.proxy = nil
	}

	final class AnchorView: UIView {
		weak var proxy: ReaderSidebarNativeScrollViewProxy?
		private weak var attachedScrollView: UIScrollView?

		override func didMoveToSuperview() {
			super.didMoveToSuperview()
			attachIfPossible()
		}

		override func didMoveToWindow() {
			super.didMoveToWindow()
			attachIfPossible()
		}

		func attachIfPossible() {
			var ancestor = superview
			while let candidate = ancestor {
				if let scrollView = candidate as? UIScrollView {
					if attachedScrollView !== scrollView {
						attachedScrollView = scrollView
					}
					proxy?.attach(scrollView, owner: ObjectIdentifier(self))
					return
				}
				ancestor = candidate.superview
			}
		}

		func detach() {
			proxy?.detach(owner: ObjectIdentifier(self))
			attachedScrollView = nil
		}
	}
}
