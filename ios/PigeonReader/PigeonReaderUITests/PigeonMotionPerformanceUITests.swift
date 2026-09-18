import XCTest

/// Run on a fixed device/OS and build configuration for comparable measurements. These tests
/// record actual rendering hitches; the host-side projection benchmark does not.
@MainActor
final class PigeonMotionPerformanceUITests: XCTestCase {
	private var app: XCUIApplication!

	override func setUp() async throws {
		continueAfterFailure = false
		app = XCUIApplication()
		app.launchArguments = ["-reader-sample-data", "-reader-show-sidebar", "-reader-reset-reader-state",
			"-reader-navigation-fixture", "-reader-motion-stress-fixture"]
		app.launch()
		if folder.waitForExistence(timeout: 2) == false {
			// Startup may restore the fixture's For You feed as a compact detail
			// push. Pop it explicitly before measuring sidebar work.
			let backCandidates = [
				app.navigationBars.buttons["Back"].firstMatch,
				app.buttons["Back"].firstMatch,
				app.buttons["BackButton"].firstMatch,
			]
			for back in backCandidates where back.waitForExistence(timeout: 2) && back.isHittable {
				back.tap()
				break
			}
		}
		XCTAssertTrue(folder.waitForExistence(timeout: 10))
	}

	func testLargeFolderExpansionAndCollapseHitches() {
		let options = XCTMeasureOptions()
		options.iterationCount = 3
		measure(metrics: metrics, options: options) {
			for _ in 0..<3 {
				folder.tap()
				XCTAssertTrue(feed(1).waitForExistence(timeout: 5))
				folder.tap()
				XCTAssertTrue(feed(1).waitForNonExistence(timeout: 5))
			}
		}
	}

	func testRepeatedCachedFeedNavigationHitches() {
		folder.tap()
		let options = XCTMeasureOptions()
		options.iterationCount = 3
		measure(metrics: metrics, options: options) {
			for number in [1, 3, 1] {
				feed(number).tap()
				XCTAssertTrue(app.staticTexts["Motion story 1"].firstMatch.waitForExistence(timeout: 5))
				if folder.isHittable == false {
					let pane = app.descendants(matching: .any)["collection-pane-feed/navigation-1-\(number)"].firstMatch
					let start = pane.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
					start.press(forDuration: 0.1, thenDragTo: pane.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
					XCTAssertTrue(folder.waitForExistence(timeout: 5))
				}
			}
		}
	}

	func testLargeSidebarScrollHitches() {
		folder.tap()
		let sidebar = app.descendants(matching: .any)["reader-sidebar"].firstMatch
		let options = XCTMeasureOptions()
		options.iterationCount = 3
		measure(metrics: metrics + [XCTOSSignpostMetric.scrollingAndDecelerationMetric], options: options) {
			sidebar.swipeUp()
			sidebar.swipeDown()
		}
	}

	private var metrics: [any XCTMetric] {
		[XCTClockMetric(), XCTCPUMetric(application: app), XCTMemoryMetric(application: app), XCTHitchMetric(application: app)]
	}

	private var folder: XCUIElement { app.buttons["reader-sidebar-folder-toggle-navigation-folder-1"] }
	private func feed(_ number: Int) -> XCUIElement {
		app.descendants(matching: .any)["reader-sidebar-item-feed/navigation-1-\(number)"].firstMatch
	}
}
