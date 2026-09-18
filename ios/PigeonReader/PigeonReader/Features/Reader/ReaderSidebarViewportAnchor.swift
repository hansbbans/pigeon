import CoreGraphics

/// The small amount of scrolling needed after a folder expands. The calculation
/// intentionally works in viewport coordinates so it can be tested without a
/// SwiftUI hierarchy or a simulator.
nonisolated struct ReaderSidebarViewportRevealPlan: Equatable {
	let delta: CGFloat
	let targetOffsetY: CGFloat
	let targetID: String?
	let animationDuration: Double?

	init(
		delta: CGFloat,
		targetOffsetY: CGFloat,
		targetID: String?,
		animationDuration: Double? = nil,
	) {
		self.delta = delta
		self.targetOffsetY = targetOffsetY
		self.targetID = targetID
		self.animationDuration = animationDuration
	}
}

/// The bounded offset correction used after a folder collapses. The target
/// offset is derived from the folder's measured screen position before and
/// after the row removal, so the native scroll view only moves as much as is
/// needed to keep that folder under the user's finger.
nonisolated struct ReaderSidebarViewportCollapsePlan: Equatable {
	let delta: CGFloat
	let targetOffsetY: CGFloat
	let targetID: String
}

nonisolated enum ReaderSidebarViewportAnchor {
	static let defaultRowHeight: CGFloat = 44
	static let minimumFolderVisibility: CGFloat = 24
	static let geometryTolerance: CGFloat = 0.5

	static func plan(
		folderFrame: CGRect,
		firstChildFrame: CGRect?,
		viewportFrame: CGRect,
		contentOffsetY: CGFloat,
		minimumOffsetY: CGFloat,
		maximumOffsetY: CGFloat,
		rowHeight: CGFloat = defaultRowHeight,
		minimumFolderVisibility: CGFloat = Self.minimumFolderVisibility,
		targetID: String? = nil,
		animationDuration: Double? = nil,
	) -> ReaderSidebarViewportRevealPlan? {
		guard folderFrame.height > 0,
			viewportFrame.height > 0,
			rowHeight > 0,
			maximumOffsetY >= minimumOffsetY else {
			return nil
		}

		// The first child can be virtualized before its row has a frame. Its
		// position is still deterministic: it starts immediately below the
		// folder row.
		let childFrame = firstChildFrame ?? CGRect(
			x: folderFrame.minX,
			y: folderFrame.maxY,
			width: max(folderFrame.width, 1),
			height: rowHeight,
		)
		let overflow = max(0, childFrame.maxY - viewportFrame.maxY)
		guard overflow > 0.5 else {
			return nil
		}

		// Keep the tapped folder under the user's finger. A very short viewport
		// leaves the folder in place instead of moving it out of view just to
		// reveal a child.
		let folderVisibility = min(max(minimumFolderVisibility, 0), folderFrame.height)
		let maximumFolderPreservingShift = max(
			0,
			folderFrame.maxY - (viewportFrame.minY + folderVisibility),
		)
		// ScrollViewReader aligns the target child to the bottom edge. Only ask it
		// to move when that exact alignment can keep the tapped folder visible;
		// an impossibly short viewport should leave the folder in place.
		guard overflow <= maximumFolderPreservingShift,
			overflow > 0.5 else {
			return nil
		}
		let requestedShift = overflow

		let targetOffsetY = min(
			max(contentOffsetY + requestedShift, minimumOffsetY),
			maximumOffsetY,
		)
		let effectiveShift = targetOffsetY - contentOffsetY
		guard effectiveShift > geometryTolerance else {
			return nil
		}
		return ReaderSidebarViewportRevealPlan(
			delta: effectiveShift,
			targetOffsetY: targetOffsetY,
			targetID: targetID,
			animationDuration: animationDuration,
		)
	}

	static func collapsePlan(
		folderID: String,
		capturedFolderFrame: CGRect,
		currentFolderFrame: CGRect,
		contentOffsetY: CGFloat,
		minimumOffsetY: CGFloat,
		maximumOffsetY: CGFloat,
	) -> ReaderSidebarViewportCollapsePlan? {
		guard capturedFolderFrame.height > 0,
			currentFolderFrame.height > 0,
			maximumOffsetY >= minimumOffsetY else {
			return nil
		}

		// A change in the folder's viewport position is the inverse of the
		// scroll-view movement needed to put it back at its captured position.
		// Clamp that requested movement to the native content bounds so a short
		// list or an end-of-content collapse never creates an artificial offset.
		let requestedShift = currentFolderFrame.minY - capturedFolderFrame.minY
		let targetOffsetY = min(
			max(contentOffsetY + requestedShift, minimumOffsetY),
			maximumOffsetY,
		)
		let effectiveShift = targetOffsetY - contentOffsetY
		guard abs(effectiveShift) > geometryTolerance else {
			return nil
		}
		return ReaderSidebarViewportCollapsePlan(
			delta: effectiveShift,
			targetOffsetY: targetOffsetY,
			targetID: folderID,
		)
	}
}
