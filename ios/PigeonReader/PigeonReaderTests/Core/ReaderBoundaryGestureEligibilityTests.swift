import Testing
@testable import PigeonReader

struct ReaderBoundaryGestureEligibilityTests {
	@Test func ordinaryScrollingDoesNotStartAnArticlePull() {
		let middle = ReaderBoundaryNavigationState(isAtTop: false, isAtBottom: false)
		#expect(ReaderBoundaryNavigation.pullDirection(startedAt: middle, velocityX: 0, velocityY: -500) == nil)
		#expect(ReaderBoundaryNavigation.pullDirection(startedAt: middle, velocityX: 0, velocityY: 500) == nil)
	}

	@Test func horizontalBackSwipesAndInwardScrollingStayWithTheSystem() {
		let top = ReaderBoundaryNavigationState(isAtTop: true, isAtBottom: false)
		let bottom = ReaderBoundaryNavigationState(isAtTop: false, isAtBottom: true)
		#expect(ReaderBoundaryNavigation.pullDirection(startedAt: top, velocityX: 500, velocityY: 20) == nil)
		#expect(ReaderBoundaryNavigation.pullDirection(startedAt: top, velocityX: 0, velocityY: -500) == nil)
		#expect(ReaderBoundaryNavigation.pullDirection(startedAt: bottom, velocityX: 0, velocityY: 500) == nil)
	}

	@Test func shortArticlesAllowPullingInEitherDirectionButRequireMovement() {
		let short = ReaderBoundaryNavigationState(isAtTop: true, isAtBottom: true)
		#expect(ReaderBoundaryNavigation.pullDirection(startedAt: short, velocityX: 0, velocityY: -20) == .next)
		#expect(ReaderBoundaryNavigation.pullDirection(startedAt: short, velocityX: 0, velocityY: 20) == .previous)
		#expect(ReaderBoundaryNavigation.pullDirection(startedAt: short, velocityX: 0, velocityY: 0) == nil)
	}

	@Test func nativeGeometryHonorsAdjustedInsetsAtBothEnds() {
		let atTop = ReaderBoundaryScrollGeometry.boundaryState(
			contentOffsetY: -24,
			contentSizeHeight: 1_200,
			boundsHeight: 800,
			adjustedInsetTop: 24,
			adjustedInsetBottom: 34,
		)
		#expect(atTop == ReaderBoundaryNavigationState(isAtTop: true, isAtBottom: false))

		let atBottom = ReaderBoundaryScrollGeometry.boundaryState(
			contentOffsetY: 434,
			contentSizeHeight: 1_200,
			boundsHeight: 800,
			adjustedInsetTop: 24,
			adjustedInsetBottom: 34,
		)
		#expect(atBottom == ReaderBoundaryNavigationState(isAtTop: false, isAtBottom: true))
	}

	@Test func nativeGeometryMarksShortContentAtBothBoundaries() {
		let shortContent = ReaderBoundaryScrollGeometry.boundaryState(
			contentOffsetY: -20,
			contentSizeHeight: 300,
			boundsHeight: 600,
			adjustedInsetTop: 20,
			adjustedInsetBottom: 34,
		)
		#expect(shortContent == ReaderBoundaryNavigationState(isAtTop: true, isAtBottom: true))
	}

	@Test func freshNativeSnapshotReplacesStaleSwiftUIBoundaryState() {
		let staleSwiftUIState = ReaderBoundaryNavigationState(isAtTop: false, isAtBottom: true)
		let freshNativeState = ReaderBoundaryScrollGeometry.boundaryState(
			contentOffsetY: -20,
			contentSizeHeight: 300,
			boundsHeight: 600,
			adjustedInsetTop: 20,
			adjustedInsetBottom: 34,
		)

		#expect(staleSwiftUIState != freshNativeState)
		#expect(ReaderBoundaryNavigation.pullDirection(
			startedAt: freshNativeState,
			velocityX: 0,
			velocityY: 500,
		) == .previous)
	}
}
