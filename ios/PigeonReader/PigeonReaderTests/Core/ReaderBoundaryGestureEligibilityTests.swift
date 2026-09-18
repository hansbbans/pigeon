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
}
