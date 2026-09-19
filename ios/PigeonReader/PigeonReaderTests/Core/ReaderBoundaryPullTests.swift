import Testing
@testable import PigeonReader

struct ReaderBoundaryPullTests {
	@Test
	func previousPullArmsOnlyAfterAQualifiedDistanceAndUsesPositiveDisplacement() {
		var state = ReaderBoundaryPullState(direction: .previous)

		state.update(translationX: 4, translationY: 40)
		#expect(state.phase == .pulling)
		#expect(state.isArmed == false)
		#expect(state.signedDisplacement == 40)

		state.update(translationX: 0, translationY: ReaderBoundaryNavigation.pullArmDistance)
		#expect(state.isArmed)
		#expect(state.shouldCommit)
		#expect(state.progress == 1)
		#expect(state.signedDisplacement > 0)
	}

	@Test
	func nextPullUsesNegativeDisplacementAndReversingDisarmsWithoutCommitting() {
		var state = ReaderBoundaryPullState(direction: .next)

		state.update(translationX: 0, translationY: -100)
		#expect(state.isArmed)
		#expect(state.signedDisplacement < 0)

		state.update(translationX: 0, translationY: 12)
		#expect(state.isArmed == false)
		#expect(state.shouldCommit == false)
		#expect(state.distance == 0)
	}

	@Test
	func unavailableTargetNeverArmsEvenWhenTheUserPullsPastTheThreshold() {
		var state = ReaderBoundaryPullState(direction: .next)

		state.update(
			translationX: 0,
			translationY: -ReaderBoundaryNavigation.pullMaximumDistance,
			isReady: false,
		)

		#expect(state.distance > 0)
		#expect(state.isArmed == false)
		#expect(state.shouldCommit == false)
	}

	@MainActor
	@Test
	func controllerEmitsOneArmEventAndRejectsStaleArticleUpdates() {
		let controller = ReaderBoundaryPullController()
		let preview = ReaderBoundaryPullPreview(
			direction: .next,
			articleID: "next",
			title: "Next story",
			isReady: true,
		)
		controller.begin(articleID: "current", direction: .next, preview: preview)

		#expect(
			controller.update(
				articleID: "current",
				direction: .next,
				translationX: 0,
				translationY: -ReaderBoundaryNavigation.pullArmDistance,
				preview: preview,
			),
		)
		#expect(
			controller.update(
				articleID: "current",
				direction: .next,
				translationX: 0,
				translationY: -100,
				preview: preview,
			) == false,
		)
		#expect(
			controller.update(
				articleID: "changed-current",
				direction: .next,
				translationX: 0,
				translationY: -100,
				preview: preview,
			) == false,
		)
		#expect(controller.finish())
		#expect(controller.state == nil)
		#expect(controller.preview == nil)
	}

	@MainActor
	@Test
	func controllerDoesNotArmAtCollectionEndAndCancelClearsPreview() {
		let controller = ReaderBoundaryPullController()
		let preview = ReaderBoundaryPullPreview(
			direction: .previous,
			articleID: nil,
			title: nil,
			isReady: false,
		)
		controller.begin(articleID: "current", direction: .previous, preview: preview)

		#expect(
			controller.update(
				articleID: "current",
				direction: .previous,
				translationX: 0,
				translationY: ReaderBoundaryNavigation.pullMaximumDistance,
				preview: preview,
			) == false,
		)
		#expect(controller.state?.isArmed == false)
		controller.cancel()
		#expect(controller.state == nil)
		#expect(controller.preview == nil)
	}
}
