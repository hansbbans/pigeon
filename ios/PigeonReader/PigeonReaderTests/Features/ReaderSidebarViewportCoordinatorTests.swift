import CoreGraphics
import SwiftUI
import Testing
@testable import PigeonReader

@MainActor
struct ReaderSidebarViewportCoordinatorTests {
	@Test func collapseCancelsPendingRevealAndInvalidatesRemovedRows() {
		let coordinator = configuredCoordinator()
		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		let oldGeneration = coordinator.currentGeneration
		#expect(coordinator.hasPendingReveal)

		coordinator.cancelPendingReveal(removingRowIDs: ["child"])
		#expect(coordinator.hasPendingReveal == false)

		coordinator.updateRowFrame(
			CGRect(x: 0, y: 384, width: 300, height: 44),
			for: "child",
			generation: oldGeneration,
		)
		#expect(coordinator.consumeRevealPlan() == nil)
	}

	@Test func rapidReversalIgnoresLateGeometryFromPriorExpansion() {
		let coordinator = configuredCoordinator()
		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		let firstGeneration = coordinator.currentGeneration
		coordinator.cancelPendingReveal(removingRowIDs: ["child"])
		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		let newestGeneration = coordinator.currentGeneration

		coordinator.updateRowFrame(
			CGRect(x: 0, y: 1_000, width: 300, height: 44),
			for: "child",
			generation: firstGeneration,
		)
		#expect(coordinator.consumeRevealPlan() == nil)

		coordinator.updateRowFrame(
			CGRect(x: 0, y: 384, width: 300, height: 44),
			for: "child",
			generation: newestGeneration,
		)
		coordinator.updateRowFrame(.zero, for: "child", generation: firstGeneration)
		#expect(coordinator.consumeRevealPlan() == nil)
		completeExpandedLayout(in: coordinator)
		let plan = coordinator.consumeRevealPlan()
		#expect(plan?.targetID == "child")
		#expect(plan?.delta == 28)
	}

	@Test func userDraggingCancelsPendingAutomaticReveal() {
		let coordinator = configuredCoordinator()
		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		coordinator.updateScrollPhase(.tracking)

		#expect(coordinator.hasPendingReveal == false)
		#expect(coordinator.consumeRevealPlan() == nil)
	}

	@Test func completedRevealIsConsumedOnce() {
		let coordinator = configuredCoordinator()
		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		let generation = coordinator.currentGeneration
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 384, width: 300, height: 44),
			for: "child",
			generation: generation,
		)
		completeExpandedLayout(in: coordinator)

		#expect(coordinator.consumeRevealPlan() != nil)
		#expect(coordinator.consumeRevealPlan() == nil)
	}

	@Test func lateRevealFramesCannotQueueAnotherAnimationAfterExpansionSettles() {
		let coordinator = configuredCoordinator()
		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		let generation = coordinator.currentGeneration
		coordinator.finishRevealWindow(expectedGeneration: generation)

		coordinator.updateRowFrame(
			CGRect(x: 0, y: 384, width: 300, height: 44),
			for: "child",
			generation: generation,
		)
		completeExpandedLayout(in: coordinator)

		#expect(coordinator.hasPendingReveal == false)
		#expect(coordinator.consumeRevealPlan() == nil)
	}

	@Test func staleRevealWindowCompletionCannotCloseANewerExpansion() {
		let coordinator = configuredCoordinator()
		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		let staleGeneration = coordinator.currentGeneration
		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		let currentGeneration = coordinator.currentGeneration

		coordinator.finishRevealWindow(expectedGeneration: staleGeneration)
		#expect(coordinator.hasPendingReveal)

		coordinator.updateRowFrame(
			CGRect(x: 0, y: 384, width: 300, height: 44),
			for: "child",
			generation: currentGeneration,
		)
		completeExpandedLayout(in: coordinator)

		#expect(coordinator.consumeRevealPlan()?.targetID == "child")
	}

	@Test func childGeometryBeforeScrollMetricsWaitsForTheNewContentSize() {
		let coordinator = configuredCoordinator()
		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		let generation = coordinator.currentGeneration
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 384, width: 300, height: 44),
			for: "child",
			generation: generation,
		)

		#expect(coordinator.consumeRevealPlan() == nil)
		coordinator.updateScrollMetrics(
			ReaderSidebarScrollMetrics(
				contentOffsetY: 100,
				contentHeight: 1_000,
				viewportHeight: 400,
				topInset: 0,
				bottomInset: 0,
			),
		)
		#expect(coordinator.consumeRevealPlan()?.targetID == "child")
	}

	@Test func partialExpandedContentWaitsForACompleteFirstRow() {
		let coordinator = configuredCoordinator()
		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		let generation = coordinator.currentGeneration
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 384, width: 300, height: 1),
			for: "child",
			generation: generation,
		)
		coordinator.updateScrollMetrics(
			ReaderSidebarScrollMetrics(
				contentOffsetY: 100,
				contentHeight: 901,
				viewportHeight: 400,
				topInset: 0,
				bottomInset: 0,
			),
		)

		#expect(coordinator.consumeRevealPlan() == nil)
		completeExpandedLayout(in: coordinator)
		#expect(coordinator.consumeRevealPlan()?.targetID == "child")
	}

	@Test func revealCarriesOnlyTheRemainingExpansionDuration() {
		let coordinator = configuredCoordinator()
		let start = ContinuousClock.now
		coordinator.beginReveal(
			folderID: "folder",
			firstChildID: "child",
			refreshingRowIDs: ["child"],
			animationDuration: ReaderMotion.folderExpansionDuration,
			now: start,
		)
		let generation = coordinator.currentGeneration
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 384, width: 300, height: 44),
			for: "child",
			generation: generation,
		)
		completeExpandedLayout(in: coordinator)

		let duration = coordinator.consumeRevealPlan(now: start.advanced(by: .milliseconds(100)))?.animationDuration ?? 0
		#expect(duration == 0.16)
	}

	@Test func expiredRevealDeadlineClearsAnUnfinishedRequest() {
		let coordinator = configuredCoordinator()
		let start = ContinuousClock.now
		coordinator.beginReveal(
			folderID: "folder",
			firstChildID: "child",
			refreshingRowIDs: ["child"],
			animationDuration: ReaderMotion.folderExpansionDuration,
			now: start,
		)
		let generation = coordinator.currentGeneration
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 384, width: 300, height: 44),
			for: "child",
			generation: generation,
		)
		completeExpandedLayout(in: coordinator)

		#expect(coordinator.consumeRevealPlan(now: start.advanced(by: .milliseconds(300))) == nil)
		#expect(coordinator.hasPendingReveal == false)
	}

	@Test func virtualizedChildUsesMeasuredRowHeightAndSafeAreaInsets() {
		let coordinator = configuredCoordinator()
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 300, width: 300, height: 70),
			for: "folder",
			generation: coordinator.currentGeneration,
		)
		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		coordinator.updateScrollMetrics(
			ReaderSidebarScrollMetrics(
				contentOffsetY: 100,
				contentHeight: 1_000,
				viewportHeight: 400,
				topInset: 20,
				bottomInset: 30,
			),
		)

		let plan = coordinator.consumeRevealPlan()
		#expect(plan?.targetID == "child")
		#expect(plan?.delta == 70)
	}

	@Test func collapseCapturesFolderPositionAndConsumesCorrectionOnce() {
		let coordinator = configuredCoordinator()
		coordinator.beginCollapse(folderID: "folder", removingRowIDs: ["child"])
		let generation = coordinator.currentGeneration
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 364, width: 300, height: 44),
			for: "folder",
			generation: generation,
		)
		coordinator.updateScrollMetrics(
			ReaderSidebarScrollMetrics(
				contentOffsetY: 100,
				contentHeight: 800,
				viewportHeight: 400,
				topInset: 0,
				bottomInset: 0,
			),
		)

		let plan = coordinator.consumeCollapsePlan()
		#expect(plan?.targetID == "folder")
		#expect(plan?.delta == 24)
		#expect(plan?.targetOffsetY == 124)
		#expect(coordinator.consumeCollapsePlan(layoutSettled: true) == nil)
	}

	@Test func staleCollapseFramesAreIgnoredAfterRapidReversal() {
		let coordinator = configuredCoordinator()
		coordinator.beginCollapse(folderID: "folder", removingRowIDs: ["child"])
		let collapseGeneration = coordinator.currentGeneration

		coordinator.beginReveal(folderID: "folder", firstChildID: "child", refreshingRowIDs: ["child"])
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 1_000, width: 300, height: 44),
			for: "folder",
			generation: collapseGeneration,
		)

		#expect(coordinator.hasPendingCollapse == false)
		#expect(coordinator.consumeCollapsePlan() == nil)
	}

	@Test func staleAnimationCompletionCannotSettleANewerCollapse() {
		let coordinator = configuredCoordinator()
		coordinator.beginCollapse(folderID: "folder", removingRowIDs: ["child"])
		let staleGeneration = coordinator.currentGeneration
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 360, width: 300, height: 44),
			for: "folder",
			generation: staleGeneration,
		)

		coordinator.beginCollapse(folderID: "folder", removingRowIDs: ["child"])
		let currentGeneration = coordinator.currentGeneration
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 380, width: 300, height: 44),
			for: "folder",
			generation: currentGeneration,
		)
		coordinator.updateScrollMetrics(
			ReaderSidebarScrollMetrics(
				contentOffsetY: 100,
				contentHeight: 800,
				viewportHeight: 400,
				topInset: 0,
				bottomInset: 0,
			),
		)

		#expect(coordinator.consumeCollapsePlan(layoutSettled: true, expectedGeneration: staleGeneration) == nil)
		#expect(coordinator.hasPendingCollapse)
		#expect(coordinator.consumeCollapsePlan(layoutSettled: true, expectedGeneration: currentGeneration)?.targetID == "folder")
	}

	@Test func userDraggingCancelsPendingCollapse() {
		let coordinator = configuredCoordinator()
		coordinator.beginCollapse(folderID: "folder", removingRowIDs: ["child"])
		coordinator.updateScrollPhase(.tracking)

		#expect(coordinator.hasPendingCollapse == false)
		#expect(coordinator.consumeCollapsePlan() == nil)
	}

	@Test func collapseWithoutCapturedFolderFrameCompletesWithoutAStuckCorrection() {
		let coordinator = ReaderSidebarViewportCoordinator()
		coordinator.updateViewportFrame(CGRect(x: 0, y: 0, width: 300, height: 400))
		coordinator.beginCollapse(folderID: "folder", removingRowIDs: [])
		let generation = coordinator.currentGeneration
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 200, width: 300, height: 44),
			for: "folder",
			generation: generation,
		)

		#expect(coordinator.consumeCollapsePlan(layoutSettled: true) == nil)
		#expect(coordinator.hasPendingCollapse == false)
	}

	private func completeExpandedLayout(in coordinator: ReaderSidebarViewportCoordinator) {
		coordinator.updateScrollMetrics(
			ReaderSidebarScrollMetrics(
				contentOffsetY: 100,
				contentHeight: 1_000,
				viewportHeight: 400,
				topInset: 0,
				bottomInset: 0,
			),
		)
	}

	private func configuredCoordinator() -> ReaderSidebarViewportCoordinator {
		let coordinator = ReaderSidebarViewportCoordinator()
		coordinator.updateViewportFrame(CGRect(x: 0, y: 0, width: 300, height: 400))
		coordinator.updateScrollMetrics(
			ReaderSidebarScrollMetrics(
				contentOffsetY: 100,
				contentHeight: 900,
				viewportHeight: 400,
				topInset: 0,
				bottomInset: 0,
			),
		)
		coordinator.updateRowFrame(
			CGRect(x: 0, y: 340, width: 300, height: 44),
			for: "folder",
			generation: coordinator.currentGeneration,
		)
		return coordinator
	}
}
