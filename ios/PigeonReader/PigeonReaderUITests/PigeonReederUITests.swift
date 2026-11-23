import XCTest

/// The Reeder look: the library list as the root (no Home tiles), and a folder
/// or feed as a hairline list in sections, on the `-reader-cards-fixture`
/// library (a "Newsletters" folder of five feeds with stories from today, the
/// last week and a month ago).
///
/// Set `TEST_RUNNER_PIGEON_UI_SHOTS=<dir>` to also write each screenshot there.
@MainActor
final class PigeonReederUITests: XCTestCase {
	private static let folderID = "user/-/label/Newsletters"
	private var app: XCUIApplication!

	override func setUp() async throws {
		continueAfterFailure = false
		app = XCUIApplication()
		app.launchEnvironment["PIGEON_UI_TEST_LOOK"] = "reeder"
	}

	func testReederOpensOnTheLibraryWithoutHomeTiles() throws {
		app.launchArguments = ["-reader-sample-data", "-reader-reset-reader-state", "-reader-show-sidebar"]
		app.launchWithoutAnimations()

		let sidebar = element("reader-sidebar")
		revealLibrary()
		XCTAssertTrue(sidebar.waitForExistence(timeout: 15))
		XCTAssertFalse(element("reader-home-tiles").exists)
		XCTAssertFalse(app.buttons["reader-home-show-tiles"].exists)
		XCTAssertTrue(element("reader-sidebar-item-forYou").exists)
		capture("reeder-library")

		// The look switch lives in the library's More menu.
		app.buttons["library-more"].tap()
		XCTAssertTrue(app.buttons["library-look"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Settings"].exists)
		app.buttons["library-look"].tap()
		app.buttons["Cards"].tap()
		if UIDevice.current.userInterfaceIdiom == .pad {
			// An iPad always has a list open beside the library; Cards keeps it
			// open, with Home one step back.
			let back = app.buttons["BackButton"].firstMatch
			XCTAssertTrue(back.waitForExistence(timeout: 10), "Cards keeps the open list above Home")
			back.tap()
		}
		XCTAssertTrue(element("reader-home-tiles").waitForExistence(timeout: 10), "Cards reaches Home")
	}

	func testAFolderIsSectionsWithTodayLastSevenDaysAndFeeds() throws {
		launchFolder()
		XCTAssertTrue(element("article-section-today").waitForExistence(timeout: 15))
		XCTAssertTrue(element("article-section-last-7-days").exists)
		capture("reeder-folder-top")

		// Seven stories arrived today; Today shows five until asked.
		XCTAssertFalse(app.staticTexts["Why bundles come back"].exists)
		let moreToday = app.buttons["article-section-more-today"]
		scroll(to: moreToday)
		moreToday.tap()
		XCTAssertTrue(app.staticTexts["Why bundles come back"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.buttons["article-section-more-today"].exists)

		let stratechery = element("article-feed-section-feed/cards-strat")
		scroll(to: stratechery)
		capture("reeder-folder-feeds")
		// Feeds with nothing from the last 7 days wait under Older.
		let older = element("article-section-older")
		scroll(to: older)
		XCTAssertTrue(element("article-feed-section-feed/cards-browser").exists)
		capture("reeder-folder-older")
	}

	func testAFeedLabelOpensTheFeedInDaySections() throws {
		launchFolder()
		XCTAssertTrue(element("article-section-today").waitForExistence(timeout: 15))
		let stratechery = element("article-feed-section-feed/cards-strat")
		scroll(to: stratechery)
		stratechery.tap()

		let bar = app.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH %@", "Stratechery")).firstMatch
		XCTAssertTrue(bar.waitForExistence(timeout: 10))
		// A feed's own list is by day, and its labels open nothing.
		XCTAssertTrue(element("article-section-today").waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["The Aggregator's dilemma, revisited for an age of agents"].exists)
		XCTAssertFalse(element("article-feed-section-feed/cards-strat").exists)
		capture("reeder-feed")

		// A feed's sections are its order: no sort menu.
		app.buttons["article-list-more"].tap()
		XCTAssertTrue(app.buttons["article-list-density"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.buttons["article-list-sort"].exists)
	}

	func testSearchInAFolderIsOneFlatListNamingEachFeed() throws {
		launchFolder()
		XCTAssertTrue(element("article-section-today").waitForExistence(timeout: 15))
		let search = app.searchFields.firstMatch
		XCTAssertTrue(search.waitForExistence(timeout: 5))
		search.tap()
		search.typeText("Aggregator")
		XCTAssertTrue(app.staticTexts["The Aggregator's dilemma, revisited for an age of agents"].waitForExistence(timeout: 10))
		// Results are not the folder's sections, and every row names its feed.
		XCTAssertFalse(element("article-section-today").exists)
		XCTAssertFalse(element("article-feed-section-feed/cards-strat").exists)
		XCTAssertTrue(app.staticTexts["Stratechery"].exists)
	}

	private func launchFolder() {
		app.launchArguments = [
			"-reader-sample-data", "-reader-reset-reader-state", "-reader-cards-fixture",
			"-reader-cards-open", Self.folderID,
		]
		app.launchWithoutAnimations()
	}

	private func element(_ identifier: String) -> XCUIElement {
		app.descendants(matching: .any)[identifier].firstMatch
	}

	/// An iPad in portrait has room for the list and the story only; the
	/// library is behind the sidebar button.
	private func revealLibrary() {
		let showSidebar = app.buttons["Show Sidebar"]
		if showSidebar.waitForExistence(timeout: 5), showSidebar.isHittable {
			showSidebar.tap()
		}
	}

	private func scroll(to target: XCUIElement) {
		// Swipe the folder's list, not the window: on an iPad the middle of
		// the window is the story column.
		let pane = element("collection-pane-\(Self.folderID)")
		for _ in 0..<10 where target.exists == false || target.isHittable == false {
			if pane.exists { pane.swipeUp() } else { app.swipeUp() }
		}
		XCTAssertTrue(target.exists, "\(target) never scrolled into view")
	}

	private func capture(_ name: String) {
		let screenshot = XCUIScreen.main.screenshot()
		let attachment = XCTAttachment(screenshot: screenshot)
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
		if let directory = ProcessInfo.processInfo.environment["PIGEON_UI_SHOTS"] {
			try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
		}
	}
}
