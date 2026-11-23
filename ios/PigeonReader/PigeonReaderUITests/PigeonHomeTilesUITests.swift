import XCTest

/// The tile home and All Feeds in the Cards look, on iPhone and iPad. Every
/// other UI test starts on the library list.
@MainActor
final class PigeonHomeTilesUITests: XCTestCase {
	private var app: XCUIApplication!

	override func setUp() async throws {
		continueAfterFailure = false
		app = XCUIApplication()
		app.launchEnvironment["PIGEON_UI_TEST_LOOK"] = "cards"
		app.launchArguments = ["-reader-sample-data", "-reader-show-sidebar", "-reader-reset-reader-state", "-reader-folder-read-data"]
		app.launchWithoutAnimations()
	}

	func testHomeShowsViewAndFolderTilesWithoutUnread() throws {
		try skipUnlessTileHome()
		XCTAssertTrue(tile("forYou").isHittable)
		XCTAssertTrue(tile("today").exists)
		XCTAssertTrue(tile("lastSevenDays").exists)
		XCTAssertTrue(tile("saved").exists)
		XCTAssertFalse(tile("unread").exists)
		XCTAssertTrue(app.descendants(matching: .any)["reader-home-dateline"].firstMatch.exists)

		let folder = tile("user/-/label/Design")
		XCTAssertTrue(folder.exists)
		XCTAssertEqual(folder.label, "Design")
		attachScreenshot(named: "home-tiles")
	}

	func testTilesOpenTheirListsAndBackReturnsToTheTiles() throws {
		try skipUnlessTileHome()
		tile("user/-/label/Design").tap()
		let designBar = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Design")).firstMatch
		XCTAssertTrue(designBar.waitForExistence(timeout: 10))
		returnHome(from: designBar)
		XCTAssertTrue(tile("forYou").waitForExistence(timeout: 10))
		XCTAssertTrue(tile("forYou").isHittable)

		tile("forYou").tap()
		let forYouBar = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "For You")).firstMatch
		XCTAssertTrue(forYouBar.waitForExistence(timeout: 10))
	}

	func testLastSevenDaysOpensAsAFrontPageInCards() throws {
		// The sample library's stories are months old; the cards fixture dates
		// its stories from launch, so the week has something in it.
		app.terminate()
		app.launchArguments = ["-reader-sample-data", "-reader-show-sidebar", "-reader-reset-reader-state", "-reader-cards-fixture"]
		app.launchWithoutAnimations()
		try skipUnlessTileHome()
		attachScreenshot(named: "home-tiles-five-views")
		let week = tile("lastSevenDays")
		for _ in 0..<3 where week.isHittable == false {
			app.swipeUp()
		}
		week.tap()
		let bar = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Last 7 Days")).firstMatch
		XCTAssertTrue(bar.waitForExistence(timeout: 10))
		// A smart view in Cards is a Front Page.
		let story = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "front-page-story-")).firstMatch
		XCTAssertTrue(story.waitForExistence(timeout: 10))
		attachScreenshot(named: "home-last-7-days")
	}

	func testAllFeedsShowsTheLibraryAsTilesAndHomeReturns() throws {
		try skipUnlessTileHome()
		showAllFeeds()

		let library = app.descendants(matching: .any)["reader-library-tiles"].firstMatch
		XCTAssertTrue(library.waitForExistence(timeout: 10))
		XCTAssertFalse(app.descendants(matching: .any)["reader-sidebar"].firstMatch.exists)
		// Every view, Unread included; counts are spoken, not shown.
		let unread = tile("unread")
		XCTAssertTrue(unread.waitForExistence(timeout: 5))
		XCTAssertTrue((unread.value as? String)?.hasSuffix("unread") == true)
		// Each folder, then its feeds.
		XCTAssertTrue(tile("user/-/label/Design").exists)
		let denseDiscovery = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "reader-sidebar-item-feed/1")).firstMatch
		XCTAssertTrue(denseDiscovery.exists)
		// No headline is cached for it, so its tile is one compact row, not an empty box.
		XCTAssertLessThan(denseDiscovery.frame.height, 52)
		attachScreenshot(named: "library-tiles")

		app.buttons["reader-home-show-tiles"].tap()
		XCTAssertTrue(app.descendants(matching: .any)["reader-home-tiles"].firstMatch.waitForExistence(timeout: 10))
		XCTAssertFalse(library.exists)
	}

	func testAFeedTileOpensTheFeed() throws {
		try skipUnlessTileHome()
		showAllFeeds()
		let feed = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "reader-sidebar-item-feed/1")).firstMatch
		XCTAssertTrue(feed.waitForExistence(timeout: 10))
		feed.tap()
		let bar = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Dense Discovery")).firstMatch
		XCTAssertTrue(bar.waitForExistence(timeout: 10))
	}

	func testAddFeedOpensTheSubscribeSheetFromTheTiles() throws {
		try skipUnlessTileHome()
		app.buttons["add-feed"].tap()
		XCTAssertTrue(app.navigationBars["Add Feed"].waitForExistence(timeout: 10))
	}

	/// Tiles are Home at every width.
	private func skipUnlessTileHome() throws {
		let tiles = app.descendants(matching: .any)["reader-home-tiles"].firstMatch
		XCTAssertTrue(tiles.waitForExistence(timeout: 15), "The tile home did not appear")
	}

	/// Cards navigates as a stack in every window: back pops to Home.
	private func returnHome(from bar: XCUIElement) {
		bar.buttons.firstMatch.tap()
	}

	private func showAllFeeds() {
		let allFeeds = app.buttons["reader-home-all-feeds"]
		for _ in 0..<4 where allFeeds.isHittable == false {
			app.swipeUp()
		}
		allFeeds.tap()
	}

	private func tile(_ id: String) -> XCUIElement {
		app.buttons["reader-sidebar-item-\(id)"]
	}

	private func attachScreenshot(named name: String) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}
}
