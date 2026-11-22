import XCTest

/// The Cards look on a folder and a feed, on the `-reader-cards-fixture`
/// library: a "Newsletters" folder of five feeds with stories from today,
/// the last week and a month ago.
@MainActor
final class PigeonCardsUITests: XCTestCase {
	private var app: XCUIApplication!
	private static let folderID = "user/-/label/Newsletters"

	override func setUp() async throws {
		continueAfterFailure = false
		app = XCUIApplication()
		app.launchEnvironment["PIGEON_UI_TEST_LOOK"] = "cards"
		app.launchArguments = [
			"-reader-sample-data", "-reader-reset-reader-state", "-reader-cards-fixture",
			"-reader-cards-open", Self.folderID,
		]
		app.launchWithoutAnimations()
	}

	func testFolderOpensAsTodayLastSevenDaysAndFeedCards() throws {
		XCTAssertTrue(element("folder-card-today").waitForExistence(timeout: 15))
		XCTAssertTrue(element("folder-card-last-7-days").exists)
		// Today mixes feeds, so each story names its feed.
		XCTAssertTrue(story(containing: "Stratechery, The Aggregator").exists)
		attachScreenshot(named: "cards-folder-top")

		// Seven stories arrived today; the card shows five until asked. The
		// story also sits in Stratechery's own card, so look in Today only.
		let today = element("folder-card-today")
		XCTAssertFalse(story(containing: "Why bundles come back", in: today).exists)
		app.buttons["folder-card-more-today"].tap()
		XCTAssertTrue(story(containing: "Why bundles come back", in: today).waitForExistence(timeout: 5))
		XCTAssertFalse(app.buttons["folder-card-more-today"].exists)

		let stratechery = app.buttons["folder-card-open-feed:feed/cards-strat"]
		scroll(to: stratechery)
		attachScreenshot(named: "cards-folder-feeds")
		// Feeds with nothing from the last 7 days wait under Older.
		let older = element("folder-cards-older")
		scroll(to: older)
		XCTAssertTrue(app.buttons["folder-card-open-feed:feed/cards-browser"].exists)
		attachScreenshot(named: "cards-folder-older")
	}

	func testAFeedCardHeaderOpensTheFeedAsDayCards() throws {
		XCTAssertTrue(element("folder-card-today").waitForExistence(timeout: 15))
		let stratechery = app.buttons["folder-card-open-feed:feed/cards-strat"]
		scroll(to: stratechery)
		stratechery.tap()

		let bar = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Stratechery")).firstMatch
		XCTAssertTrue(bar.waitForExistence(timeout: 10))
		XCTAssertTrue(element("folder-card-today").waitForExistence(timeout: 10))
		// One feed: no feed names over its stories.
		XCTAssertTrue(story(containing: "The Aggregator").exists)
		XCTAssertFalse(story(containing: "Stratechery, The Aggregator").exists)
		attachScreenshot(named: "cards-feed")
	}

	func testCardsHaveNoSortMenuAndAStoryOpensAndReturns() throws {
		XCTAssertTrue(element("folder-card-today").waitForExistence(timeout: 15))
		app.buttons["article-list-more"].tap()
		XCTAssertTrue(app.buttons["Display"].waitForExistence(timeout: 5))
		// The cards' sections are the order, so there is nothing to sort.
		XCTAssertFalse(app.buttons["article-list-sort"].exists)
		app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()

		let first = story(containing: "The Aggregator")
		XCTAssertTrue(first.waitForExistence(timeout: 5))
		first.tap()
		let back = element("article-back-to-feed")
		XCTAssertTrue(back.waitForExistence(timeout: 10))
		back.tap()
		XCTAssertTrue(element("folder-card-today").waitForExistence(timeout: 10))
	}

	private func element(_ identifier: String) -> XCUIElement {
		app.descendants(matching: .any)[identifier].firstMatch
	}

	private func story(containing text: String, in container: XCUIElement? = nil) -> XCUIElement {
		(container ?? app).buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "folder-card-story-", text)).firstMatch
	}

	private func scroll(to target: XCUIElement) {
		for _ in 0..<8 where target.exists == false || target.isHittable == false {
			app.swipeUp()
		}
		XCTAssertTrue(target.exists, "\(target) never scrolled into view")
	}

	private func attachScreenshot(named name: String) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}
}
