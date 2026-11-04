import XCTest

/// YouTube transcripts under the player, with the preview fetcher standing in
/// for YouTube (no network): get one, follow it, and recover from a failure.
@MainActor
final class PigeonTranscriptUITests: XCTestCase {
	private var app: XCUIApplication!

	override func setUp() async throws {
		continueAfterFailure = false
		app = XCUIApplication()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-youtube",
			"-reader-reset-reader-state",
		]
	}

	func testGetTranscriptShowsChaptersAndTappingALineMakesItCurrent() throws {
		app.launchWithoutAnimations()
		XCTAssertTrue(app.staticTexts["A practical guide to making better videos"].waitForExistence(timeout: 15))

		let getTranscript = app.buttons["transcript-get"]
		XCTAssertTrue(reveal(getTranscript), "Get Transcript sits under the player")
		XCTAssertEqual(getTranscript.label, "Get Transcript")
		getTranscript.tap()

		let first = app.buttons["transcript-segment-0"]
		XCTAssertTrue(first.waitForExistence(timeout: 10))
		XCTAssertFalse(app.buttons["transcript-get"].exists, "the button gives way to the transcript")
		XCTAssertTrue(app.staticTexts["Transcript"].exists)
		XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Chapter: Framing")).firstMatch.exists, "chapters appear as headings")
		XCTAssertTrue(first.label.contains("Every video starts with a single frame"))

		let third = app.buttons["transcript-segment-2"]
		XCTAssertTrue(reveal(third))
		XCTAssertFalse(third.isSelected)
		third.tap()
		XCTAssertTrue(waitFor(third, \.isSelected), "the tapped line becomes the playing one")
		XCTAssertFalse(first.isSelected)
		attachScreenshot(named: "youtube-transcript")
	}

	func testAFailedFetchShowsAMessageAndTryAgainRecovers() throws {
		app.launchArguments.append("-reader-transcript-fail-once")
		app.launchWithoutAnimations()
		XCTAssertTrue(app.staticTexts["A practical guide to making better videos"].waitForExistence(timeout: 15))

		let getTranscript = app.buttons["transcript-get"]
		XCTAssertTrue(reveal(getTranscript))
		getTranscript.tap()

		let failure = app.otherElements["transcript-failed"].firstMatch
		let tryAgain = app.buttons["transcript-try-again"]
		XCTAssertTrue(tryAgain.waitForExistence(timeout: 10), "a failure ends in a message, not a spinner")
		XCTAssertTrue(failure.exists || app.staticTexts["YouTube took too long to answer."].exists)
		XCTAssertFalse(app.otherElements["transcript-loading"].exists)
		attachScreenshot(named: "youtube-transcript-failed")

		tryAgain.tap()
		XCTAssertTrue(app.buttons["transcript-segment-0"].waitForExistence(timeout: 10))
		XCTAssertFalse(app.buttons["transcript-try-again"].exists)
	}

	/// Waits for `element`; XCUITest scrolls it into view when it is tapped.
	private func reveal(_ element: XCUIElement) -> Bool {
		element.waitForExistence(timeout: 10)
	}

	private func waitFor(_ element: XCUIElement, _ property: KeyPath<XCUIElement, Bool>, timeout: TimeInterval = 5) -> Bool {
		let deadline = Date.now.addingTimeInterval(timeout)
		while Date.now < deadline {
			if element[keyPath: property] { return true }
			RunLoop.current.run(until: Date.now.addingTimeInterval(0.1))
		}
		return element[keyPath: property]
	}

	private func attachScreenshot(named name: String) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}
}
