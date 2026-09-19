import Testing
import UIKit
@testable import PigeonReader

@MainActor
@Suite(.serialized)
struct ReaderListViewportControllerResizeTests {
	@Test func widthResizeRestoresTheSamePartialRowOffset() async throws {
		let fixture = try ReaderListViewportResizeFixture()
		defer { fixture.teardown() }
		await fixture.settle()

		guard let before = fixture.store.position(for: fixture.context) else {
			Issue.record("The initial native row position was not captured")
			return
		}
		#expect(before.articleID == fixture.articleID)
		#expect(before.viewportOffset < 0)

		fixture.resize(width: 240, rowY: 336, rowHeight: 112, contentOffsetY: 360)
		await fixture.settle()

		guard let after = fixture.store.position(for: fixture.context) else {
			Issue.record("The resized native row position was not retained")
			return
		}
		#expect(after.articleID == before.articleID)
		#expect(abs(after.viewportOffset - before.viewportOffset) <= 0.5)
		#expect(abs(fixture.rowViewportOffset - before.viewportOffset) <= 0.5)

		// A later ordinary scroll must be observed normally; this catches a
		// resize state that keeps restoring forever after its first success.
		fixture.scroll(to: 280)
		await fixture.settle()
		guard let afterUserScroll = fixture.store.position(for: fixture.context) else {
			Issue.record("The post-resize scroll position was not saved")
			return
		}
		#expect(abs(afterUserScroll.viewportOffset - 56) <= 0.5)
	}

	@Test func successiveLiveResizeFramesKeepTheOriginalAnchor() async throws {
		let fixture = try ReaderListViewportResizeFixture()
		defer { fixture.teardown() }
		await fixture.settle()

		guard let before = fixture.store.position(for: fixture.context) else {
			Issue.record("The initial native row position was not captured")
			return
		}

		// Apply several native bounds/layout frames before yielding to the
		// controller. This matches an iPad window drag and ensures intermediate
		// row heights cannot replace the original partial-row anchor.
		fixture.resize(width: 280, rowY: 304, rowHeight: 92, contentOffsetY: 345)
		fixture.resize(width: 255, rowY: 320, rowHeight: 104, contentOffsetY: 352)
		fixture.resize(width: 220, rowY: 344, rowHeight: 120, contentOffsetY: 368)
		await fixture.settle()

		guard let after = fixture.store.position(for: fixture.context) else {
			Issue.record("The final native row position was not retained")
			return
		}
		#expect(after.articleID == before.articleID)
		#expect(abs(after.viewportOffset - before.viewportOffset) <= 0.5)
		#expect(abs(fixture.rowViewportOffset - before.viewportOffset) <= 0.5)
	}

	@Test func scrollAndInsetOnlyChangesDoNotStartResizeRestoration() async throws {
		let fixture = try ReaderListViewportResizeFixture()
		defer { fixture.teardown() }
		await fixture.settle()

		fixture.resize(width: 320, height: 460, rowHeight: 80, contentOffsetY: 342)
		await fixture.settle()
		#expect(abs(fixture.scrollView.contentOffset.y - 342) <= 0.5)

		fixture.scrollView.contentInset = UIEdgeInsets(top: 12, left: 0, bottom: 28, right: 0)
		fixture.scrollView.contentOffset = CGPoint(x: 0, y: 342)
		fixture.rootViewController.view.setNeedsLayout()
		fixture.rootViewController.view.layoutIfNeeded()
		await fixture.settle()

		#expect(abs(fixture.scrollView.contentOffset.y - 342) <= 0.5)

		let boundsOrigin = fixture.scrollView.bounds.origin
		fixture.scrollView.bounds.origin = CGPoint(x: boundsOrigin.x, y: boundsOrigin.y + 8)
		await fixture.settle()

		#expect(abs(fixture.scrollView.contentOffset.y - 350) <= 0.5)
	}

	@Test func resizeRestorationClampsToTheNativeContentBounds() async throws {
		let fixture = try ReaderListViewportResizeFixture()
		defer { fixture.teardown() }
		await fixture.settle()

		fixture.resize(width: 240, rowHeight: 112, contentOffsetY: 1_000, contentHeight: 600)
		await fixture.settle()

		let maximum = max(
			-fixture.scrollView.adjustedContentInset.top,
			fixture.scrollView.contentSize.height - fixture.scrollView.bounds.height + fixture.scrollView.adjustedContentInset.bottom,
		)
		#expect(fixture.scrollView.contentOffset.y <= maximum + 0.5)
	}

	@Test func windowMoveReattachesRowsRegisteredBeforeHostingWrapperJoinsScrollView() async throws {
		let fixture = try ReaderListViewportResizeFixture(registerBeforeWrapperAttachment: true)
		defer { fixture.teardown() }
		await fixture.settle()

		guard let position = fixture.store.position(for: fixture.context) else {
			Issue.record("The viewport did not attach after the hosting wrapper entered the window")
			return
		}
		#expect(position.articleID == fixture.articleID)
		#expect(position.viewportOffset < 0)
	}

	@Test func shrinkingAVisibleAnchorKeepsItsFollowingContentInTheViewport() async throws {
		let fixture = try ReaderListViewportResizeFixture(
			initialRowHeight: 120,
			initialContentOffsetY: 370,
			includeFollowingContent: true,
		)
		defer { fixture.teardown() }
		await fixture.settle()

		guard let before = fixture.store.position(for: fixture.context) else {
			Issue.record("The initial tall-row position was not captured")
			return
		}
		#expect(before.viewportOffset == -70)

		fixture.resize(width: 240, rowY: 300, rowHeight: 16, contentOffsetY: 370)
		await fixture.settle()

		#expect(abs(fixture.rowViewportOffset - (-15)) <= 0.5)
		#expect(fixture.followingContentIsVisible)
	}

	@Test func densityReflowWaitsForTheAnchoredRowsOwnLayout() async throws {
		let fixture = try ReaderListViewportResizeFixture()
		defer { fixture.teardown() }
		await fixture.settle()
		let before = try #require(fixture.store.position(for: fixture.context))
		var completed = false
		fixture.controller.prepareForLayoutReflow { completed = true }

		// A native list first revises its estimated content size and lays out
		// other cells. Neither proves that the captured row has its final size.
		let otherRow = UIView(frame: CGRect(x: 0, y: 900, width: 320, height: 40))
		fixture.scrollView.addSubview(otherRow)
		fixture.controller.register(otherRow, articleID: "another-story")
		fixture.scrollView.contentSize.height = 1_800
		fixture.controller.noteRowLayoutPass(otherRow)
		fixture.controller.captureCurrentPosition()
		#expect(completed == false)

		fixture.row.frame = CGRect(x: 0, y: 220, width: 320, height: 40)
		fixture.row.setNeedsLayout()
		fixture.row.layoutIfNeeded()
		await fixture.settle()
		#expect(completed)
		#expect(abs(fixture.rowViewportOffset - before.viewportOffset) <= 0.5)
	}

	@Test func densityReflowMeasuresTheRowAfterItsNativeContainerFinishesLayout() async throws {
		let fixture = try ReaderListViewportResizeFixture()
		defer { fixture.teardown() }
		await fixture.settle()
		let before = try #require(fixture.store.position(for: fixture.context))
		fixture.controller.prepareForLayoutReflow()

		// SwiftUI lays out the smaller row before UIKit applies its final cell
		// position. Restoring from this intermediate frame would scroll too far.
		fixture.row.frame.size.height = 40
		fixture.row.setNeedsLayout()
		fixture.row.layoutIfNeeded()
		fixture.scrollView.pendingRowLayout = { fixture.row.frame.origin.y = 220 }
		fixture.scrollView.setNeedsLayout()
		fixture.controller.captureCurrentPosition()
		fixture.scrollView.layoutIfNeeded()
		await fixture.settle()

		#expect(abs(fixture.rowViewportOffset - before.viewportOffset) <= 0.5)
	}
}

@MainActor
private final class DeferredRowLayoutScrollView: UIScrollView {
	var pendingRowLayout: (() -> Void)?

	override func layoutSubviews() {
		super.layoutSubviews()
		let layout = pendingRowLayout
		pendingRowLayout = nil
		layout?()
	}
}

@MainActor
private final class ReaderListViewportResizeFixture {
	let window: UIWindow
	let rootViewController: UIViewController
	let scrollView: DeferredRowLayoutScrollView
	let row: ReaderListRowAnchor.AnchorView
	let followingContent: UIView
	let controller: ReaderListViewportController
	let store: ReaderListPositionStore
	let context = "resize-fixture"
	let articleID = "story"

	init(
		registerBeforeWrapperAttachment: Bool = false,
		initialRowHeight: CGFloat = 80,
		initialContentOffsetY: CGFloat = 330,
		includeFollowingContent: Bool = false,
	) throws {
		let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
		window = UIWindow(windowScene: scene)
		window.frame = CGRect(x: 0, y: 0, width: 320, height: 520)
		rootViewController = UIViewController()
		scrollView = DeferredRowLayoutScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 520))
		row = ReaderListRowAnchor.AnchorView()
		followingContent = UIView(frame: CGRect(x: 0, y: 300 + initialRowHeight, width: 320, height: 40))
		controller = ReaderListViewportController()
		store = ReaderListPositionStore()

		window.rootViewController = rootViewController
		window.makeKeyAndVisible()
		rootViewController.view.frame = window.bounds
		rootViewController.view.addSubview(scrollView)
		scrollView.contentInsetAdjustmentBehavior = .never
		scrollView.alwaysBounceVertical = true
		scrollView.contentSize = CGSize(width: 320, height: 2_000)

		row.controller = controller
		row.articleID = articleID
		row.frame = CGRect(x: 0, y: 300, width: 320, height: initialRowHeight)
		if registerBeforeWrapperAttachment {
			let hostingWrapper = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 2_000))
			hostingWrapper.addSubview(row)
			if includeFollowingContent { hostingWrapper.addSubview(followingContent) }
			// Match SwiftUI's ordering: the representable registers while its
			// hosting wrapper is detached, then that wrapper joins the List later.
			controller.register(row, articleID: articleID)
			scrollView.addSubview(hostingWrapper)
		} else {
			scrollView.addSubview(row)
			if includeFollowingContent { scrollView.addSubview(followingContent) }
			controller.register(row, articleID: articleID)
		}
		_ = controller.activate(
			context: context,
			articleIDs: [articleID],
			store: store,
			onNearEnd: { _ in },
			onUserScroll: {},
			onRestorationComplete: {},
			onNavigationActivity: { _ in },
		)
		scrollView.contentOffset = CGPoint(x: 0, y: initialContentOffsetY)
		rootViewController.view.layoutIfNeeded()
	}

	var rowViewportOffset: Double {
		let frame = row.convert(row.bounds, to: scrollView)
		let top = scrollView.contentOffset.y + scrollView.adjustedContentInset.top
		return Double(frame.minY - top)
	}

	var followingContentIsVisible: Bool {
		let frame = followingContent.convert(followingContent.bounds, to: scrollView)
		let top = scrollView.contentOffset.y + scrollView.adjustedContentInset.top
		let bottom = scrollView.contentOffset.y + scrollView.bounds.height - scrollView.adjustedContentInset.bottom
		return frame.maxY > top && frame.minY < bottom
	}

	func resize(
		width: CGFloat,
		height: CGFloat = 520,
		rowY: CGFloat = 300,
		rowHeight: CGFloat,
		contentOffsetY: CGFloat,
		contentHeight: CGFloat = 2_000,
	) {
		scrollView.frame.size = CGSize(width: width, height: height)
		scrollView.contentSize = CGSize(width: width, height: contentHeight)
		row.frame = CGRect(x: 0, y: rowY, width: width, height: rowHeight)
		followingContent.frame = CGRect(x: 0, y: rowY + rowHeight, width: width, height: followingContent.bounds.height)
		scrollView.contentOffset = CGPoint(x: 0, y: contentOffsetY)
		rootViewController.view.setNeedsLayout()
		rootViewController.view.layoutIfNeeded()
	}

	func scroll(to y: CGFloat) {
		scrollView.setContentOffset(CGPoint(x: 0, y: y), animated: false)
	}

	func settle() async {
		for _ in 0..<12 { await Task.yield() }
	}

	func teardown() {
		controller.deactivate()
		window.resignKey()
		window.isHidden = true
		rootViewController.view = nil
	}
}
