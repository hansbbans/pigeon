import Foundation

nonisolated enum ReaderBoundaryNavigationDirection: Equatable, Sendable {
	case previous
	case next
}

nonisolated struct ReaderBoundaryNavigationState: Equatable, Sendable {
	let isAtTop: Bool
	let isAtBottom: Bool
}

/// Pure decision logic for navigating between articles from a reader boundary.
///
/// The scroll view captures the boundary state when a drag begins. This keeps an
/// ordinary scroll that reaches a boundary from being mistaken for a navigation
/// gesture.
nonisolated enum ReaderBoundaryNavigation {
	static let minimumVerticalTranslation = 80.0

	static func direction(
		startedAt state: ReaderBoundaryNavigationState,
		translationX: Double,
		translationY: Double,
		minimumVerticalTranslation: Double = Self.minimumVerticalTranslation,
	) -> ReaderBoundaryNavigationDirection? {
		guard abs(translationY) >= max(minimumVerticalTranslation, 1), abs(translationY) > abs(translationX) else {
			return nil
		}

		if translationY < 0, state.isAtBottom {
			return .next
		}
		if translationY > 0, state.isAtTop {
			return .previous
		}
		return nil
	}

	static func targetIndex(
		currentIndex: Int,
		count: Int,
		direction: ReaderBoundaryNavigationDirection,
	) -> Int? {
		guard count > 0, currentIndex >= 0, currentIndex < count else {
			return nil
		}

		switch direction {
		case .previous:
			let index = currentIndex - 1
			return index >= 0 ? index : nil
		case .next:
			let index = currentIndex + 1
			return index < count ? index : nil
		}
	}
}
