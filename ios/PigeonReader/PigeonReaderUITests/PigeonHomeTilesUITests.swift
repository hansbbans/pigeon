import XCTest

/// The iPhone tile home. Every other UI test starts on the library list.
@MainActor
final class PigeonHomeTilesUITests: XCTestCase {
	private var app: XCUIApplication!

	override func setUp() async throws {
		continueAfterFailure = false
		app = XCUIApplication()
		app.launchArguments = ["-reader-sample-data", "-reader-show-sidebar", "-reader-reset-reader-state", "-reader-folder-read-data"]
		app.launchWithoutAnimations()
	}

	func testHomeShowsViewAndFolderTilesWithoutUnread() throws {
		try skipUnlessTileHome()
		XCTAssertTrue(tile("forYou").isHittable)
		XCTAssertTrue(tile("today").exists)
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
		designBar.buttons.firstMatch.tap()
		XCTAssertTrue(tile("forYou").waitForExistence(timeout: 10))

		tile("forYou").tap()
		let forYouBar = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "For You")).firstMatch
		XCTAssertTrue(forYouBar.waitForExistence(timeout: 10))
	}

	func testAllFeedsShowsTheLibraryListAndHomeReturnsToTheTiles() throws {
		try skipUnlessTileHome()
		let allFeeds = app.buttons["reader-home-all-feeds"]
		for _ in 0..<4 where allFeeds.isHittable == false {
			app.swipeUp()
		}
		allFeeds.tap()

		let sidebar = app.descendants(matching: .any)["reader-sidebar"].firstMatch
		XCTAssertTrue(sidebar.waitForExistence(timeout: 10))
		// Unread counts live here, not on the tiles.
		let unread = app.descendants(matching: .any)["reader-sidebar-item-unread"].firstMatch
		XCTAssertTrue(unread.waitForExistence(timeout: 5))
		XCTAssertTrue((unread.value as? String)?.hasSuffix("unread") == true)

		app.buttons["reader-home-show-tiles"].tap()
		XCTAssertTrue(app.descendants(matching: .any)["reader-home-tiles"].firstMatch.waitForExistence(timeout: 10))
		XCTAssertFalse(sidebar.exists)
	}

	func testAddFeedOpensTheSubscribeSheetFromTheTiles() throws {
		try skipUnlessTileHome()
		app.buttons["add-feed"].tap()
		XCTAssertTrue(app.navigationBars["Add Feed"].waitForExistence(timeout: 10))
	}

	/// Tiles are the compact-width home; iPad keeps the list.
	private func skipUnlessTileHome() throws {
		let tiles = app.descendants(matching: .any)["reader-home-tiles"].firstMatch
		if tiles.waitForExistence(timeout: 15) == false {
			try XCTSkipIf(app.descendants(matching: .any)["reader-sidebar"].firstMatch.exists, "Regular width uses the library list")
			XCTFail("Neither the tile home nor the library list appeared")
		}
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
