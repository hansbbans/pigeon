import XCTest

@MainActor
final class PigeonReaderUITests: XCTestCase {
	private var app: XCUIApplication!

	override func setUpWithError() throws {
		continueAfterFailure = false
		app = XCUIApplication()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-article",
			"-reader-reset-reader-state",
		]
		app.launch()
		XCTAssertTrue(app.staticTexts["Designing calmer tools for people who read every day"].waitForExistence(timeout: 15))
	}

	func testLinkedImageAndExistingLinkChoice() throws {
		try tapLinkedImage()
		attachScreenshot(named: "linked-image-dialog")

		XCTAssertTrue(app.buttons["View image"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Open link"].exists)
		app.buttons["Open link"].tap()
		XCTAssertTrue(app.buttons["Open in Browser"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Share to Reader"].exists)
		attachScreenshot(named: "linked-image-link-choice")
	}

	func testLinkedImageOpensZoomViewer() throws {
		try tapLinkedImage()
		app.buttons["View image"].tap()
		XCTAssertTrue(app.navigationBars["Image"].waitForExistence(timeout: 5))
		attachScreenshot(named: "linked-image-zoom")
	}

	func testNormalLinkUsesExistingLinkChoice() throws {
		try tapNormalLink()
		attachScreenshot(named: "normal-link-choice")
		XCTAssertTrue(app.buttons["Open in Browser"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Share to Reader"].exists)
	}

	func testModeMenuWebsiteAndBackToFeedContent() throws {
		let mode = app.buttons["Feed Content"]
		XCTAssertTrue(mode.waitForExistence(timeout: 5))
		mode.tap()
		app.buttons["Website"].tap()
		XCTAssertTrue(app.buttons["Website"].waitForExistence(timeout: 10))
		attachScreenshot(named: "website-mode")

		app.buttons["Website"].tap()
		app.buttons["Feed Content"].tap()
		XCTAssertTrue(app.buttons["Feed Content"].waitForExistence(timeout: 5))
		attachScreenshot(named: "feed-content-after-website")
	}

	func testReaderViewSuccess() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-article",
			"-reader-reset-reader-state",
			"-reader-reader-success",
		]
		app.launch()
		XCTAssertTrue(app.staticTexts["Designing calmer tools for people who read every day"].waitForExistence(timeout: 15))
		app.buttons["Feed Content"].tap()
		app.buttons["Reader View"].tap()
		XCTAssertTrue(app.otherElements["reader-view-loaded-content"].waitForExistence(timeout: 30))
		XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 5))
		XCTAssertFalse(app.staticTexts["Preparing Reader View"].exists)
		XCTAssertFalse(app.staticTexts["Reader View unavailable"].exists)
		attachScreenshot(named: "reader-view-success")
	}

	func testReaderViewExplicitFallback() throws {
		app.buttons["Feed Content"].tap()
		app.buttons["Reader View"].tap()
		XCTAssertTrue(app.staticTexts["Reader View unavailable"].waitForExistence(timeout: 15))
		XCTAssertTrue(app.buttons["Use Feed Content"].exists)
		attachScreenshot(named: "reader-view-fallback")
	}

	private func tapLinkedImage() throws {
		let image = app.images["A notebook beside a cup of coffee"]
		for attempt in 0..<6 {
			if image.exists {
				image.tap()
			} else {
				app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62)).tap()
			}
			if app.buttons["View image"].waitForExistence(timeout: 1) {
				return
			}
			if attempt < 5 {
				app.swipeUp()
			}
		}
		XCTFail("The linked fixture image did not open its image dialog.")
	}

	private func tapNormalLink() throws {
		let normalLink = app.links["Read the design notes"]
		for attempt in 0..<8 {
			if normalLink.exists {
				normalLink.tap()
			} else {
				app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72)).tap()
			}
			if app.buttons["Open in Browser"].waitForExistence(timeout: 1) {
				return
			}
			XCTAssertFalse(
				app.buttons["View image"].exists || app.buttons["Open link"].exists,
				"The normal-link helper hit the linked-image dialog; the fixture target should be accessible directly.",
			)
			if attempt < 7 {
				app.swipeUp()
			}
		}
		XCTFail("The normal fixture link did not open the existing link-choice dialog.")
	}

	private func attachScreenshot(named name: String) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}
}
