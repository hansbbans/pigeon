import CoreGraphics
import Testing
@testable import PigeonReader

struct ReaderSidebarViewportAnchorTests {
	@Test func noRevealWhenFirstChildFitsInsideViewport() {
		let plan = ReaderSidebarViewportAnchor.plan(
			folderFrame: CGRect(x: 0, y: 120, width: 300, height: 44),
			firstChildFrame: CGRect(x: 0, y: 164, width: 300, height: 44),
			viewportFrame: CGRect(x: 0, y: 0, width: 300, height: 400),
			contentOffsetY: 0,
			minimumOffsetY: 0,
			maximumOffsetY: 500,
		)
		#expect(plan == nil)
	}

	@Test func nearBottomRevealsOnlyTheFirstChildOverflow() {
		let plan = ReaderSidebarViewportAnchor.plan(
			folderFrame: CGRect(x: 0, y: 340, width: 300, height: 44),
			firstChildFrame: CGRect(x: 0, y: 384, width: 300, height: 44),
			viewportFrame: CGRect(x: 0, y: 0, width: 300, height: 400),
			contentOffsetY: 100,
			minimumOffsetY: 0,
			maximumOffsetY: 500,
		)
		#expect(plan?.delta == 28)
		#expect(plan?.targetOffsetY == 128)
	}

	@Test func revealIsBoundedSoTheTappedFolderStaysVisible() {
		let plan = ReaderSidebarViewportAnchor.plan(
			folderFrame: CGRect(x: 0, y: 0, width: 300, height: 44),
			firstChildFrame: CGRect(x: 0, y: 44, width: 300, height: 100),
			viewportFrame: CGRect(x: 0, y: 0, width: 300, height: 60),
			contentOffsetY: 0,
			minimumOffsetY: 0,
			maximumOffsetY: 500,
		)
		#expect(plan == nil)
	}

	@Test func revealHonorsScrollBoundsAndDoesNotMoveAtTheEnd() {
		let plan = ReaderSidebarViewportAnchor.plan(
			folderFrame: CGRect(x: 0, y: 340, width: 300, height: 44),
			firstChildFrame: CGRect(x: 0, y: 384, width: 300, height: 44),
			viewportFrame: CGRect(x: 0, y: 0, width: 300, height: 400),
			contentOffsetY: 500,
			minimumOffsetY: 0,
			maximumOffsetY: 500,
		)
		#expect(plan == nil)
	}

	@Test func collapseRestoresTheCapturedFolderPositionWithTheSmallestShift() {
		let plan = ReaderSidebarViewportAnchor.collapsePlan(
			folderID: "folder",
			capturedFolderFrame: CGRect(x: 0, y: 100, width: 300, height: 44),
			currentFolderFrame: CGRect(x: 0, y: 124, width: 300, height: 44),
			contentOffsetY: 200,
			minimumOffsetY: 0,
			maximumOffsetY: 500,
		)

		#expect(plan?.targetID == "folder")
		#expect(plan?.delta == 24)
		#expect(plan?.targetOffsetY == 224)
	}

	@Test func collapseCanMoveBackTowardsTheTopWhenNativeListShiftedTheFolderUp() {
		let plan = ReaderSidebarViewportAnchor.collapsePlan(
			folderID: "folder",
			capturedFolderFrame: CGRect(x: 0, y: 180, width: 300, height: 44),
			currentFolderFrame: CGRect(x: 0, y: 136, width: 300, height: 44),
			contentOffsetY: 40,
			minimumOffsetY: 0,
			maximumOffsetY: 500,
		)

		#expect(plan?.delta == -40)
		#expect(plan?.targetOffsetY == 0)
	}

	@Test func collapseClampsToNativeBoundsWhenExactPositionIsImpossible() {
		let plan = ReaderSidebarViewportAnchor.collapsePlan(
			folderID: "folder",
			capturedFolderFrame: CGRect(x: 0, y: 100, width: 300, height: 44),
			currentFolderFrame: CGRect(x: 0, y: 180, width: 300, height: 44),
			contentOffsetY: 190,
			minimumOffsetY: 0,
			maximumOffsetY: 200,
		)

		#expect(plan?.delta == 10)
		#expect(plan?.targetOffsetY == 200)
	}

	@Test func collapseDoesNotMoveWhenTheFolderAlreadyStayedInPlace() {
		let plan = ReaderSidebarViewportAnchor.collapsePlan(
			folderID: "folder",
			capturedFolderFrame: CGRect(x: 0, y: 100, width: 300, height: 44),
			currentFolderFrame: CGRect(x: 0, y: 100.25, width: 300, height: 44),
			contentOffsetY: 190,
			minimumOffsetY: 0,
			maximumOffsetY: 200,
		)

		#expect(plan == nil)
	}
}
