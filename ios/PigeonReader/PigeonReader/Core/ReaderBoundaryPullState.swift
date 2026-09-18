import Foundation
import Observation

nonisolated enum ReaderBoundaryPullPhase: Equatable, Sendable {
	case idle
	case pulling
	case armed
}

/// The transient, synchronous state of a boundary pull.
///
/// This type deliberately contains no article or model references. A view can
/// replace its preview while a refresh is in flight without allowing stale
/// navigation data to leak into the gesture state.
nonisolated struct ReaderBoundaryPullState: Equatable, Sendable {
	let direction: ReaderBoundaryNavigationDirection
	private(set) var phase: ReaderBoundaryPullPhase
	private(set) var distance: Double
	private(set) var isReady = true

	init(direction: ReaderBoundaryNavigationDirection) {
		self.direction = direction
		phase = .pulling
		distance = 0
	}

	var isArmed: Bool {
		phase == .armed
	}

	var progress: Double {
		min(max(distance / ReaderBoundaryNavigation.pullArmDistance, 0), 1)
	}

	/// The displacement to apply to the reader content. Positive values pull
	/// the previous article down; negative values pull the next article up.
	var signedDisplacement: Double {
		direction == .previous ? distance : -distance
	}

	/// A restrained visual offset layered over the scroll view's own rubberband.
	/// Keeping this below the recognizer distance prevents the two effects from
	/// making a boundary pull feel loose or from moving the article too far.
	var visualDisplacement: Double {
		let softenedDistance = min(distance * 0.6, ReaderBoundaryNavigation.pullArmDistance * 0.8)
		return direction == .previous ? softenedDistance : -softenedDistance
	}

	/// Updates the pull from the recognizer's translation. Returning to the
	/// opposite side of the boundary smoothly reduces the indicator to zero and
	/// disarms the gesture; the recognizer remains active so releasing then
	/// cleanly cancels without committing navigation.
	mutating func update(translationX: Double, translationY: Double, isReady: Bool = true) {
		self.isReady = isReady
		guard abs(translationY) > abs(translationX) else {
			distance = 0
			phase = .pulling
			return
		}

		let directionalTranslation: Double
		switch direction {
		case .previous:
			directionalTranslation = translationY
		case .next:
			directionalTranslation = -translationY
		}
		let projectedDistance = max(directionalTranslation, 0)
		let cappedDistance = min(projectedDistance, ReaderBoundaryNavigation.pullMaximumDistance)
		let armDistance = ReaderBoundaryNavigation.pullArmDistance
		distance = cappedDistance <= armDistance
			? cappedDistance
			: armDistance + ((cappedDistance - armDistance) * 0.35)
		phase = isReady && distance >= ReaderBoundaryNavigation.pullArmDistance ? .armed : .pulling
	}

	var shouldCommit: Bool {
		isArmed && isReady
	}

	mutating func reset() {
		distance = 0
		phase = .pulling
		isReady = true
	}
}

/// Read-only article data shown by the transient boundary indicator.
nonisolated struct ReaderBoundaryPullPreview: Equatable, Sendable {
	let direction: ReaderBoundaryNavigationDirection
	let articleID: String?
	let title: String?
	let isReady: Bool

	var actionTitle: String {
		switch direction {
		case .previous: "Previous story"
		case .next: "Next story"
		}
	}

	var statusText: String {
		if isReady {
			return "Pull to open"
		}
		return direction == .previous ? "Start of collection" : "End of collection"
	}
}

/// Main-actor owner for a live pull. Keeping this object outside the article
/// content view prevents every translation update from rebuilding HTML.
@MainActor
@Observable
final class ReaderBoundaryPullController {
	private(set) var state: ReaderBoundaryPullState?
	private(set) var preview: ReaderBoundaryPullPreview?
	private(set) var articleID: String?
	var boundaryState = ReaderBoundaryNavigationState(isAtTop: true, isAtBottom: true)
	private var hasEmittedArmEvent = false

	var direction: ReaderBoundaryNavigationDirection? {
		state?.direction
	}

	func begin(
		articleID: String,
		direction: ReaderBoundaryNavigationDirection,
		preview: ReaderBoundaryPullPreview,
	) {
		guard state == nil else { return }
		self.articleID = articleID
		self.preview = preview
		self.state = ReaderBoundaryPullState(direction: direction)
		hasEmittedArmEvent = false
	}

	func update(
		articleID: String,
		direction: ReaderBoundaryNavigationDirection,
		translationX: Double,
		translationY: Double,
		preview: ReaderBoundaryPullPreview,
	) -> Bool {
		guard self.articleID == articleID,
			var state,
			state.direction == direction else {
			return false
		}

		let wasArmed = state.isArmed
		state.update(
			translationX: translationX,
			translationY: translationY,
			isReady: preview.isReady,
		)
		self.state = state
		self.preview = preview
		guard wasArmed == false, state.isArmed, hasEmittedArmEvent == false else {
			return false
		}
		hasEmittedArmEvent = true
		return true
	}

	func finish() -> Bool {
		let shouldCommit = state?.shouldCommit == true
		reset()
		return shouldCommit
	}

	func cancel() {
		reset()
	}

	private func reset() {
		state = nil
		preview = nil
		articleID = nil
		hasEmittedArmEvent = false
	}
}
