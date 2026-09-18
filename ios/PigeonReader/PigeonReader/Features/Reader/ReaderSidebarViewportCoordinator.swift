import SwiftUI

nonisolated struct ReaderSidebarScrollMetrics: Equatable {
	let contentOffsetY: CGFloat
	let contentHeight: CGFloat
	let viewportHeight: CGFloat
	let topInset: CGFloat
	let bottomInset: CGFloat

	var minimumOffsetY: CGFloat {
		-topInset
	}

	var maximumOffsetY: CGFloat {
		max(minimumOffsetY, contentHeight - viewportHeight + bottomInset)
	}

	static let zero = Self(
		contentOffsetY: 0,
		contentHeight: 0,
		viewportHeight: 0,
		topInset: 0,
		bottomInset: 0,
	)
}

/// Coordinates the asynchronous List layout pass after a folder toggle.
/// Keeping this state outside the view body lets a rapid reversal replace the
/// old request before a delayed row-frame callback can auto-scroll the list.
@MainActor
final class ReaderSidebarViewportCoordinator {
	private struct PendingReveal: Equatable {
		let folderID: String
		let firstChildID: String?
		let baselineContentHeight: CGFloat
		let folderFrameAtRequest: CGRect
		let animationDeadline: ContinuousClock.Instant?
	}

	private struct PendingCollapse: Equatable {
		let folderID: String
		let capturedFolderFrame: CGRect?
		let requestGeneration: Int
		let baselineContentHeight: CGFloat
		let metricsRevisionAtRequest: Int
	}

	private var pendingReveal: PendingReveal?
	private var pendingCollapse: PendingCollapse?
	private var rowFrames: [String: CGRect] = [:]
	private var rowFrameGenerations: [String: Int] = [:]
	private var viewportFrame: CGRect = .zero
	private var metrics = ReaderSidebarScrollMetrics.zero
	private var metricsRevision = 0
	private var scrollPhase: ScrollPhase = .idle
	private var generation = 0
	private var minimumGenerationByRowID: [String: Int] = [:]

	var currentGeneration: Int {
		generation
	}

	var hasPendingReveal: Bool {
		pendingReveal != nil
	}

	var hasPendingCollapse: Bool {
		pendingCollapse != nil
	}

	func isCurrentGeneration(_ candidate: Int) -> Bool {
		generation == candidate
	}

	func beginReveal(
		folderID: String,
		firstChildID: String?,
		refreshingRowIDs: [String],
		animationDuration: Double? = nil,
		now: ContinuousClock.Instant = ContinuousClock.now,
	) {
		pendingCollapse = nil
		generation &+= 1
		minimumGenerationByRowID[folderID] = generation
		for id in refreshingRowIDs {
			minimumGenerationByRowID[id] = generation
			rowFrames[id] = nil
		}
		let animationDeadline = animationDuration.map { duration in
			now.advanced(by: .milliseconds(Int64(duration * 1_000)))
		}
		pendingReveal = PendingReveal(
			folderID: folderID,
			firstChildID: firstChildID,
			baselineContentHeight: metrics.contentHeight,
			folderFrameAtRequest: rowFrames[folderID] ?? .zero,
			animationDeadline: animationDeadline,
		)
	}

	func beginCollapse(folderID: String, removingRowIDs: [String]) {
		pendingReveal = nil
		generation &+= 1
		let capturedFolderFrame = rowFrames[folderID]
		minimumGenerationByRowID[folderID] = generation
		rowFrames[folderID] = nil
		rowFrameGenerations[folderID] = generation - 1
		for id in removingRowIDs {
			minimumGenerationByRowID[id] = generation
			rowFrames[id] = nil
			rowFrameGenerations[id] = generation - 1
		}
		guard let capturedFolderFrame, capturedFolderFrame.height > 0 else {
			// A folder that was never measured cannot supply a stable screen
			// anchor. The collapse still proceeds, but no delayed correction is
			// left behind for a later unrelated layout pass.
			pendingCollapse = nil
			return
		}
		pendingCollapse = PendingCollapse(
			folderID: folderID,
			capturedFolderFrame: capturedFolderFrame,
			requestGeneration: generation,
			baselineContentHeight: metrics.contentHeight,
			metricsRevisionAtRequest: metricsRevision,
		)
	}

	func cancelPendingReveal(removingRowIDs: [String] = []) {
		generation &+= 1
		pendingReveal = nil
		pendingCollapse = nil
		for id in removingRowIDs {
			minimumGenerationByRowID[id] = generation
			rowFrames[id] = nil
			rowFrameGenerations[id] = generation - 1
		}
	}

	/// Closes the animated reveal window when the expansion animation settles.
	/// A layout callback that arrives after that point must not start a second
	/// scroll animation. A mismatched generation belongs to a newer gesture.
	func finishRevealWindow(expectedGeneration: Int) {
		guard generation == expectedGeneration else { return }
		pendingReveal = nil
	}

	func updateRowFrame(_ frame: CGRect, for id: String, generation callbackGeneration: Int) {
		guard callbackGeneration >= minimumGenerationByRowID[id, default: 0] else {
			return
		}
		guard frame.width > 0, frame.height > 0 else {
			rowFrames[id] = nil
			rowFrameGenerations[id] = callbackGeneration
			return
		}
		rowFrames[id] = frame
		rowFrameGenerations[id] = callbackGeneration
	}

	func updateViewportFrame(_ frame: CGRect) {
		viewportFrame = frame
	}

	func updateScrollMetrics(_ metrics: ReaderSidebarScrollMetrics) {
		metricsRevision &+= 1
		self.metrics = metrics
	}

	func updateScrollPhase(_ phase: ScrollPhase) {
		scrollPhase = phase
		if phase == .tracking || phase == .interacting {
			// A user gesture always wins over an automatic reveal requested by a
			// prior layout pass.
			pendingReveal = nil
			pendingCollapse = nil
		}
	}

	func consumeRevealPlan(now: ContinuousClock.Instant = ContinuousClock.now) -> ReaderSidebarViewportRevealPlan? {
		guard let pendingReveal, scrollPhase == .idle else {
			return nil
		}
		let remainingAnimationDuration: Double?
		if let animationDeadline = pendingReveal.animationDeadline {
			let remaining = now.duration(to: animationDeadline)
			let components = remaining.components
			let seconds = Double(components.seconds) + Double(components.attoseconds) / 1e18
			guard seconds > 0 else {
				self.pendingReveal = nil
				return nil
			}
			remainingAnimationDuration = seconds
		} else {
			remainingAnimationDuration = nil
		}
		guard metrics.contentHeight > pendingReveal.baselineContentHeight + 0.5 else {
			return nil
		}

		let folderFrame = rowFrames[pendingReveal.folderID] ?? pendingReveal.folderFrameAtRequest
		guard folderFrame.height > 0 else {
			return nil
		}
		guard let viewportFrame = usableViewportFrame else {
			return nil
		}
		let firstChildFrame = pendingReveal.firstChildID.flatMap { rowFrames[$0] }
		let rowHeight = max(folderFrame.height, ReaderSidebarViewportAnchor.defaultRowHeight)
		let hasMeasuredFullFirstRow: Bool
		if let firstChildFrame {
			hasMeasuredFullFirstRow = firstChildFrame.height + ReaderSidebarViewportAnchor.geometryTolerance >= rowHeight
		} else {
			hasMeasuredFullFirstRow = false
		}
		let hasContentForFirstRow = metrics.contentHeight >= pendingReveal.baselineContentHeight + rowHeight - ReaderSidebarViewportAnchor.geometryTolerance
		let hasFullFirstRow = hasMeasuredFullFirstRow || hasContentForFirstRow
		guard hasFullFirstRow else {
			return nil
		}
		let plan = ReaderSidebarViewportAnchor.plan(
			folderFrame: folderFrame,
			firstChildFrame: hasMeasuredFullFirstRow ? firstChildFrame : nil,
			viewportFrame: viewportFrame,
			contentOffsetY: metrics.contentOffsetY,
			minimumOffsetY: metrics.minimumOffsetY,
			maximumOffsetY: metrics.maximumOffsetY,
			rowHeight: rowHeight,
			targetID: pendingReveal.firstChildID,
			animationDuration: remainingAnimationDuration,
		)
		// Once the post-toggle layout is available, this request is complete even
		// when the child already fits. It must not reappear after a later scroll.
		self.pendingReveal = nil
		return plan
	}

	func consumeCollapsePlan(
		layoutSettled: Bool = false,
		expectedGeneration: Int? = nil,
	) -> ReaderSidebarViewportCollapsePlan? {
		guard let pendingCollapse,
			scrollPhase == .idle,
			expectedGeneration == nil || expectedGeneration == generation else {
			return nil
		}

		let hasNewMetrics = metricsRevision > pendingCollapse.metricsRevisionAtRequest
		let hasNewFolderFrame = rowFrameGenerations[pendingCollapse.folderID, default: -1] >= pendingCollapse.requestGeneration
		guard hasNewMetrics || (layoutSettled && hasNewFolderFrame) else {
			return nil
		}
		guard pendingCollapse.capturedFolderFrame != nil else {
			self.pendingCollapse = nil
			return nil
		}

		let contentShrank = metrics.contentHeight < pendingCollapse.baselineContentHeight - ReaderSidebarViewportAnchor.geometryTolerance
		let currentFolderFrame: CGRect?
		if let measured = rowFrames[pendingCollapse.folderID], hasNewFolderFrame {
			currentFolderFrame = measured
		} else if contentShrank, let captured = pendingCollapse.capturedFolderFrame {
			// A stable row does not emit a second geometry callback. Once the
			// content-size callback proves the collapsed layout, its captured frame
			// is also the current frame and no correction is needed.
			currentFolderFrame = captured
		} else {
			currentFolderFrame = nil
		}
		guard let currentFolderFrame else {
			return nil
		}

		let folderMoved = pendingCollapse.capturedFolderFrame.map { captured in
			abs(currentFolderFrame.minY - captured.minY) > ReaderSidebarViewportAnchor.geometryTolerance
				|| abs(currentFolderFrame.height - captured.height) > ReaderSidebarViewportAnchor.geometryTolerance
		} ?? false
		guard contentShrank || folderMoved else {
			return nil
		}

		self.pendingCollapse = nil
		guard let capturedFolderFrame = pendingCollapse.capturedFolderFrame else {
			return nil
		}
		return ReaderSidebarViewportAnchor.collapsePlan(
			folderID: pendingCollapse.folderID,
			capturedFolderFrame: capturedFolderFrame,
			currentFolderFrame: currentFolderFrame,
			contentOffsetY: metrics.contentOffsetY,
			minimumOffsetY: metrics.minimumOffsetY,
			maximumOffsetY: metrics.maximumOffsetY,
		)
	}

	private var usableViewportFrame: CGRect? {
		let top = viewportFrame.minY + metrics.topInset
		let bottom = viewportFrame.maxY - metrics.bottomInset
		guard viewportFrame.width > 0, bottom > top else {
			return nil
		}
		return CGRect(
			x: viewportFrame.minX,
			y: top,
			width: viewportFrame.width,
			height: bottom - top,
		)
	}
}
