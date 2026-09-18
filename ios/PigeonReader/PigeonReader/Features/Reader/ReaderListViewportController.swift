import SwiftUI
import UIKit

/// Reads the native list viewport without publishing every scroll frame into
/// SwiftUI. Stable row identity survives insertions; the pixel offset preserves
/// a partially visible row when returning from a story.
@MainActor
final class ReaderListViewportController {
	private struct Row {
		weak var view: UIView?
		let articleID: String
	}
	private struct LayoutSnapshot {
		let frames: [String: CGRect]
		let contentSize: CGSize

		func changed(from previous: Self) -> Bool {
			guard contentSize == previous.contentSize, frames.count == previous.frames.count else {
				return true
			}
			for (articleID, frame) in frames {
				guard let previousFrame = previous.frames[articleID] else { return true }
				if abs(frame.minY - previousFrame.minY) > 0.5
					|| abs(frame.height - previousFrame.height) > 0.5 {
					return true
				}
			}
			return false
		}
	}
	private struct PendingReflow {
		let id: UUID
		let context: String
		let position: ReaderListPosition
		let baseline: LayoutSnapshot
		let layoutPass: UInt
	}
	private struct StableViewport {
		let context: String
		let size: CGSize
		let layout: LayoutSnapshot
		let position: ReaderListPosition?
		let layoutPass: UInt
	}
	private struct PendingViewportResize {
		let id: UUID
		let context: String
		let position: ReaderListPosition
		var baseline: LayoutSnapshot
		var layoutPass: UInt
		var size: CGSize
	}
	private struct PendingContextHandoff {
		let sourceContext: String
		let position: ReaderListPosition?
		let scope: ReaderListCollectionScope
	}
	private var rows: [ObjectIdentifier: Row] = [:]
	private weak var scrollView: UIScrollView?
	private var observation: NSKeyValueObservation?
	private var boundsObservation: NSKeyValueObservation?
	private var store: ReaderListPositionStore?
	private var context: String?
	private var scope: ReaderListCollectionScope?
	private var articleIDs: [String] = []
	private var pendingRestore: ReaderListPosition?
	private var coarseRestoreFinished = false
	private var pendingReflow: PendingReflow?
	private var pendingContextHandoff: PendingContextHandoff?
	private var active = false
	private var scheduled = false
	private var layoutPass: UInt = 0
	private var wasDragging = false
	private var onNearEnd: ((Bool) -> Void)?
	private var onUserScroll: (() -> Void)?
	private var onRestorationComplete: (() -> Void)?
	private var onNavigationActivity: ((Bool) -> Void)?
	private var onReflowComplete: (() -> Void)?
	private var restorationTimeout: Task<Void, Never>?
	private var reflowTimeout: Task<Void, Never>?
	private var viewportResizeTimeout: Task<Void, Never>?
	private var stableViewport: StableViewport?
	private var pendingViewportResize: PendingViewportResize?
	private var activationID = UUID()
	private var nativeTransitionID: ObjectIdentifier?
	private weak var lastObservedTransition: (any UIViewControllerTransitionCoordinator)?

	func activate(
		context: String, articleIDs: [String], store: ReaderListPositionStore,
		scope: ReaderListCollectionScope? = nil,
		onNearEnd: @escaping (Bool) -> Void, onUserScroll: @escaping () -> Void,
		onRestorationComplete: @escaping () -> Void,
		onNavigationActivity: @escaping (Bool) -> Void
	) -> String? {
		restorationTimeout?.cancel()
		reflowTimeout?.cancel()
		viewportResizeTimeout?.cancel()
		self.onNavigationActivity?(false)
		nativeTransitionID = nil
		lastObservedTransition = nil
		let requestID = UUID()
		activationID = requestID
		self.context = context
		self.scope = scope
		self.articleIDs = articleIDs
		self.store = store
		self.onNearEnd = onNearEnd
		self.onUserScroll = onUserScroll
		self.onRestorationComplete = onRestorationComplete
		self.onNavigationActivity = onNavigationActivity
		active = true
		pendingReflow = nil
		pendingViewportResize = nil
		stableViewport = nil
		pendingContextHandoff = nil
		onReflowComplete = nil
		reflowTimeout = nil
		viewportResizeTimeout = nil
		pendingRestore = store.position(for: context)
		if pendingRestore?.target(in: articleIDs) == nil { pendingRestore = nil }
		coarseRestoreFinished = pendingRestore == nil
		if pendingRestore == nil {
			finishRestoration()
		} else {
			// A missing/removed native row must never leave the page invisible.
			// This is only a safety bound; normal completion is driven by layout.
			restorationTimeout = Task { [weak self] in
				do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
				guard let self, self.active, self.activationID == requestID else { return }
				self.finishRestoration()
			}
		}
		scheduleUpdate()
		return pendingRestore?.target(in: articleIDs)
	}

	func completeCoarseRestore() {
		coarseRestoreFinished = true
		scheduleUpdate()
	}

	func updateArticleIDs(_ ids: [String]) {
		articleIDs = ids
		if let pendingRestore, pendingRestore.target(in: ids) == nil { finishRestoration() }
		scheduleUpdate()
	}

	/// Capture the current anchor before a filter or sort setter changes the
	/// model. The handoff is committed only after SwiftUI publishes the target
	/// context, so an ordinary feed/account switch cannot reuse this position.
	func prepareForContextChange() {
		guard active, let context, let scope else { return }
		captureCurrentPosition()
		pendingContextHandoff = PendingContextHandoff(
			sourceContext: context,
			position: store?.position(for: context),
			scope: scope,
		)
	}

	func commitContextChange(to targetContext: String, scope targetScope: ReaderListCollectionScope) {
		guard let pendingContextHandoff else { return }
		self.pendingContextHandoff = nil
		guard targetContext != pendingContextHandoff.sourceContext,
			ReaderListContextContinuity.canHandoff(from: pendingContextHandoff.scope, to: targetScope),
			let position = pendingContextHandoff.position,
			let store else { return }
		store.handoffPosition(
			position,
			from: pendingContextHandoff.sourceContext,
			to: targetContext,
			sourceScope: pendingContextHandoff.scope,
			targetScope: targetScope,
		)
	}

	/// Preserve the visible story while row heights change because of density or
	/// Dynamic Type. The baseline lets the next layout pass restore the same
	/// pixel offset without animating the list itself.
	func prepareForLayoutReflow(
		captureCurrentPosition: Bool = true,
		onComplete: (() -> Void)? = nil,
	) {
		guard active, let context, let store else {
			onComplete?()
			return
		}
		let preservedPosition = pendingReflow?.position ?? pendingViewportResize?.position
		if pendingReflow != nil {
			// A rapid second density/Dynamic Type change must not complete the
			// first change with the second callback. Keep its original anchor and
			// replace the pending request atomically.
			finishPendingReflow()
		}
		// An explicit density/Dynamic Type change takes precedence over an
		// in-flight window resize, while retaining the resize's original anchor.
		finishPendingViewportResize()
		viewportResizeTimeout?.cancel()
		viewportResizeTimeout = nil
		onReflowComplete = onComplete
		if captureCurrentPosition, preservedPosition == nil {
			self.captureCurrentPosition()
		}
		guard let position = preservedPosition ?? store.position(for: context), let baseline = currentLayoutSnapshot() else {
			let completion = onReflowComplete
			onReflowComplete = nil
			completion?()
			return
		}
		reflowTimeout?.cancel()
		let reflowID = UUID()
		pendingReflow = PendingReflow(
			id: reflowID,
			context: context,
			position: position,
			baseline: baseline,
			layoutPass: layoutPass,
		)
		reflowTimeout = Task { [weak self] in
			do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
			guard let self, self.active, self.pendingReflow?.id == reflowID else { return }
			self.finishPendingReflow()
		}
		scheduleUpdate()
	}

	func captureCurrentPosition() {
		update()
	}

	func noteRowLayoutPass() {
		layoutPass &+= 1
		scheduleUpdate()
	}

	func deactivate() {
		update()
		active = false
		pendingRestore = nil
		pendingReflow = nil
		pendingViewportResize = nil
		viewportResizeTimeout?.cancel()
		viewportResizeTimeout = nil
		stableViewport = nil
		pendingContextHandoff = nil
		onReflowComplete = nil
		reflowTimeout?.cancel()
		reflowTimeout = nil
		scope = nil
		restorationTimeout?.cancel()
		restorationTimeout = nil
		activationID = UUID()
		onRestorationComplete = nil
		nativeTransitionID = nil
		lastObservedTransition = nil
		onNavigationActivity?(false)
		onNavigationActivity = nil
		onNearEnd = nil
		onUserScroll = nil
	}

	func register(_ view: UIView, articleID: String) {
		rows[ObjectIdentifier(view)] = Row(view: view, articleID: articleID)
		scheduleUpdate()
		var ancestor = view.superview
		while let candidate = ancestor {
			if let nativeScroll = candidate as? UIScrollView {
				attach(nativeScroll)
				break
			}
			ancestor = candidate.superview
		}
		scheduleUpdate()
	}

	func unregister(_ view: UIView) {
		rows[ObjectIdentifier(view)] = nil
	}

	func scheduleUpdate() {
		guard scheduled == false else { return }
		scheduled = true
		Task { @MainActor [weak self] in
			await Task.yield()
			guard let self else { return }
			self.scheduled = false
			self.update()
		}
	}

	private func attach(_ scrollView: UIScrollView) {
		guard self.scrollView !== scrollView else { return }
		observation?.invalidate()
		boundsObservation?.invalidate()
		self.scrollView = scrollView
		observation = scrollView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
			Task { @MainActor [weak self] in self?.scheduleUpdate() }
		}
		boundsObservation = scrollView.observe(\.bounds, options: [.old, .new]) { [weak self] _, change in
			guard let previous = change.oldValue, let current = change.newValue,
				abs(previous.width - current.width) > 0.5 else { return }
			Task { @MainActor [weak self] in self?.scheduleUpdate() }
		}
	}

	private func update() {
		guard active, let scrollView, scrollView.window != nil,
			let context, let store else { return }
		rows = rows.filter { $0.value.view != nil }
		if let row = rows.values.first?.view { observeNavigationTransition(from: row) }
		if scrollView.isDragging || scrollView.isDecelerating {
			finishPendingViewportResize()
			finishPendingReflow()
			finishRestoration()
			if scrollView.isDragging, wasDragging == false { onUserScroll?() }
		}
		wasDragging = scrollView.isDragging
		if nativeTransitionID != nil { return }
		let top = scrollView.contentOffset.y + scrollView.adjustedContentInset.top
		let bottom = scrollView.contentOffset.y + scrollView.bounds.height - scrollView.adjustedContentInset.bottom
		let measured = rows.values.compactMap { row -> (String, CGRect)? in
			guard let view = row.view, view.window != nil,
				view.isDescendant(of: scrollView), view.bounds.height > 0 else { return nil }
			return (row.articleID, view.convert(view.bounds, to: scrollView))
		}
		let snapshot = LayoutSnapshot(
			frames: Dictionary(measured.map { ($0.0, $0.1) }, uniquingKeysWith: { first, second in
				first.minY <= second.minY ? first : second
			}),
			contentSize: scrollView.contentSize,
		)

		if let pendingReflow {
			guard pendingReflow.context == context,
				let target = pendingReflow.position.target(in: articleIDs) else {
				finishPendingReflow()
				return
			}
			guard let row = measured.first(where: { $0.0 == target }) else {
				// The anchor may be temporarily outside the native reuse window.
				// Keep the snapshot until layout exposes it again.
				self.pendingReflow = pendingReflow
				return
			}
			if snapshot.changed(from: pendingReflow.baseline) || layoutPass != pendingReflow.layoutPass {
				restore(pendingReflow.position, row: row, in: scrollView)
				let restoredPosition = pendingReflow.position
				finishPendingReflow()
				stableViewport = StableViewport(
					context: context,
					size: scrollView.bounds.size,
					layout: snapshot,
					position: restoredPosition,
					layoutPass: layoutPass,
				)
				scheduleUpdate()
				return
			}
			// Keep the old anchor until an actual row/layout change is observed.
			// Anchor layout callbacks or the bounded safety timeout will drive the
			// next state change; no normal timing delay is used here.
			return
		}

		if pendingViewportResize == nil,
			pendingRestore == nil,
			pendingContextHandoff == nil,
			let stableViewport,
			stableViewport.context == context,
			hasMeaningfulViewportSizeChange(from: stableViewport.size, to: scrollView.bounds.size),
			let position = stableViewport.position {
			let resizeID = UUID()
			pendingViewportResize = PendingViewportResize(
				id: resizeID,
				context: context,
				position: position,
				baseline: stableViewport.layout,
				layoutPass: stableViewport.layoutPass,
				size: scrollView.bounds.size,
			)
			armViewportResizeTimeout(for: resizeID)
		}

		if var pendingViewportResize {
			guard pendingViewportResize.context == context else {
				finishPendingViewportResize()
				return
			}
			if hasMeaningfulViewportSizeChange(from: pendingViewportResize.size, to: scrollView.bounds.size) {
				// A live iPad resize can deliver several bounds changes before the
				// row has laid itself out. Keep the original anchor, but restart the
				// layout baseline for the newest size so intermediate frames cannot
				// accumulate offset drift.
				pendingViewportResize.size = scrollView.bounds.size
				pendingViewportResize.baseline = snapshot
				pendingViewportResize.layoutPass = layoutPass
				self.pendingViewportResize = pendingViewportResize
				armViewportResizeTimeout(for: pendingViewportResize.id)
				return
			}
			guard let target = pendingViewportResize.position.target(in: articleIDs),
				let row = measured.first(where: { $0.0 == target }) else {
				// The anchor may be temporarily outside the native reuse window.
				// Keep the snapshot until layout exposes it again.
				self.pendingViewportResize = pendingViewportResize
				return
			}
			if snapshot.changed(from: pendingViewportResize.baseline)
				|| layoutPass != pendingViewportResize.layoutPass {
				restore(pendingViewportResize.position, row: row, in: scrollView)
				let restoredPosition = pendingViewportResize.position
				finishPendingViewportResize()
				stableViewport = StableViewport(
					context: context,
					size: scrollView.bounds.size,
					layout: snapshot,
					position: restoredPosition,
					layoutPass: layoutPass,
				)
				scheduleUpdate()
				return
			}
			// A bounds-only change can leave row frames untouched. Keep the
			// pending state until the native row layout reports a pass; no timer
			// is needed for ordinary resize handling.
			return
		}

		if coarseRestoreFinished, let restore = pendingRestore, let target = restore.target(in: articleIDs),
			let row = measured.first(where: { $0.0 == target }) {
			self.restore(restore, row: row, in: scrollView)
			finishRestoration()
			scheduleUpdate()
			return
		}
		guard pendingRestore == nil else { return }
		let visible = measured.filter { $0.1.maxY > top && $0.1.minY < bottom }.sorted { $0.1.minY < $1.1.minY }
		var savedPosition: ReaderListPosition?
		if let first = visible.first, let index = articleIDs.firstIndex(of: first.0) {
			let following = Array(articleIDs.dropFirst(index + 1).prefix(4))
			let previous = Array(articleIDs.prefix(index).suffix(4).reversed())
			let position = ReaderListPosition(articleID: first.0, viewportOffset: first.1.minY - top, neighbors: following + previous)
			savedPosition = position
			store.save(position, for: context)
		}
		stableViewport = StableViewport(
			context: context,
			size: scrollView.bounds.size,
			layout: snapshot,
			position: savedPosition ?? stableViewport?.position,
			layoutPass: layoutPass,
		)
		let tail = Set(articleIDs.suffix(5))
		onNearEnd?(visible.contains { tail.contains($0.0) })
	}

	private func currentLayoutSnapshot() -> LayoutSnapshot? {
		guard let scrollView, scrollView.window != nil else { return nil }
		rows = rows.filter { $0.value.view != nil }
		let frames = rows.values.compactMap { row -> (String, CGRect)? in
			guard let view = row.view, view.window != nil,
				view.isDescendant(of: scrollView), view.bounds.height > 0 else { return nil }
			return (row.articleID, view.convert(view.bounds, to: scrollView))
		}
		return LayoutSnapshot(
			frames: Dictionary(frames.map { ($0.0, $0.1) }, uniquingKeysWith: { first, second in
				first.minY <= second.minY ? first : second
			}),
			contentSize: scrollView.contentSize,
		)
	}

	private func restore(_ position: ReaderListPosition, row: (String, CGRect), in scrollView: UIScrollView) {
		let desiredOffset = row.1.minY - scrollView.adjustedContentInset.top - position.viewportOffset
		let minimum = -scrollView.adjustedContentInset.top
		let maximum = max(minimum, scrollView.contentSize.height - scrollView.bounds.height + scrollView.adjustedContentInset.bottom)
		scrollView.setContentOffset(
			CGPoint(x: scrollView.contentOffset.x, y: min(max(desiredOffset, minimum), maximum)),
			animated: false,
		)
	}

	private func hasMeaningfulViewportSizeChange(from previous: CGSize, to current: CGSize) -> Bool {
		// A height-only change changes how much of the feed is visible but does
		// not move any row. It is also how the keyboard and inset adjustments
		// commonly present themselves. Width is the native signal that can
		// reflow row content during rotation or an iPad window resize.
		abs(previous.width - current.width) > 0.5
	}

	private func finishRestoration() {
		pendingRestore = nil
		restorationTimeout?.cancel()
		restorationTimeout = nil
		let completion = onRestorationComplete
		onRestorationComplete = nil
		completion?()
	}

	private func finishPendingReflow() {
		pendingReflow = nil
		reflowTimeout?.cancel()
		reflowTimeout = nil
		// The next normal update establishes a fresh viewport baseline. This
		// prevents an explicit reflow that coincides with rotation from being
		// mistaken for a second automatic resize.
		stableViewport = nil
		let completion = onReflowComplete
		onReflowComplete = nil
		completion?()
	}

	private func finishPendingViewportResize() {
		pendingViewportResize = nil
		viewportResizeTimeout?.cancel()
		viewportResizeTimeout = nil
		// Let the next normal pass record the post-resize bounds and current
		// anchor. Keeping the pre-resize snapshot would retrigger the same
		// restoration on the next content-offset callback.
		stableViewport = nil
	}

	private func armViewportResizeTimeout(for resizeID: UUID) {
		// A reused native row can remain outside the measured window forever;
		// this is only a bounded safety escape, never the normal completion
		// path for a resize with a layout callback. Reset it for each live frame
		// so a long iPad window drag cannot fall back mid-resize.
		viewportResizeTimeout?.cancel()
		viewportResizeTimeout = Task { [weak self] in
			do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
			guard let self, self.active, self.pendingViewportResize?.id == resizeID else { return }
			self.finishPendingViewportResize()
			self.scheduleUpdate()
		}
	}

	private func observeNavigationTransition(from view: UIView) {
		guard active else { return }
		var responder: UIResponder? = view
		while let current = responder {
			if let controller = current as? UIViewController,
				let transition = controller.transitionCoordinator, transition.isAnimated {
				let id = ObjectIdentifier(transition)
				guard lastObservedTransition !== transition else { return }
				lastObservedTransition = transition
				nativeTransitionID = id
				let requestID = activationID
				onNavigationActivity?(true)
				let registered = transition.animate(alongsideTransition: nil) { [weak self] _ in
					guard let self, self.active, self.activationID == requestID, self.nativeTransitionID == id else { return }
					self.nativeTransitionID = nil
					self.onNavigationActivity?(false)
					self.scheduleUpdate()
				}
				if registered == false {
					nativeTransitionID = nil
					onNavigationActivity?(false)
				}
				return
			}
			responder = current.next
		}
	}
}

struct ReaderListRowAnchor: UIViewRepresentable {
	let articleID: String
	let controller: ReaderListViewportController

	func makeUIView(context: Context) -> AnchorView {
		let view = AnchorView()
		view.isUserInteractionEnabled = false
		return view
	}

	func updateUIView(_ view: AnchorView, context: Context) {
		view.controller = controller
		view.articleID = articleID
		controller.register(view, articleID: articleID)
	}

	static func dismantleUIView(_ view: AnchorView, coordinator: ()) {
		view.controller?.unregister(view)
		view.controller = nil
	}

	final class AnchorView: UIView {
		weak var controller: ReaderListViewportController?
		var articleID = ""
		override func didMoveToWindow() {
			super.didMoveToWindow()
			if window != nil {
				// SwiftUI can move the hosting wrapper into the native List after
				// this anchor was first registered. Re-run the ancestor walk once
				// the row is in a window so the viewport observes that List's scroll.
				controller?.register(self, articleID: articleID)
			}
			controller?.scheduleUpdate()
		}
		override func didMoveToSuperview() {
			super.didMoveToSuperview()
			controller?.register(self, articleID: articleID)
		}
		override func layoutSubviews() {
			super.layoutSubviews()
			controller?.noteRowLayoutPass()
		}
	}
}
