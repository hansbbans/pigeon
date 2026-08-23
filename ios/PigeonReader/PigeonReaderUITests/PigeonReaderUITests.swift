import XCTest

@MainActor
final class PigeonReaderUITests: XCTestCase {
	private var app: XCUIApplication!

	override func setUp() async throws {
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
		// The original page fixture is empty, but feed HTML is still readable.
		XCTAssertTrue(app.otherElements["reader-view-loaded-content"].waitForExistence(timeout: 30))
		XCTAssertFalse(app.staticTexts["Preparing Reader View"].exists)
		XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 5))
		attachScreenshot(named: "reader-view-fallback")
	}

	func testSyncHealthShowsFeedDiagnosticsAndManualRetry() throws {
		openSettings()
		let syncHealth = app.buttons["Sync Health"]
		XCTAssertTrue(syncHealth.waitForExistence(timeout: 5))
		syncHealth.tap()

		XCTAssertTrue(app.navigationBars["Sync Health"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["Design Weekly"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["design.example.com"].exists)
		XCTAssertTrue(app.staticTexts["HTTP 503"].exists)
		let retry = app.buttons["Retry Design Weekly now"]
		XCTAssertTrue(retry.exists)
		retry.tap()
		XCTAssertTrue(app.staticTexts["Design Weekly"].waitForExistence(timeout: 5))
		attachScreenshot(named: "sync-health")
	}

	func testPlatformDeliveryAndImportSettingsAreReachable() throws {
		openSettings()
		XCTAssertTrue(app.buttons["Stale Feeds"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Feed Notifications"].exists)
		XCTAssertTrue(app.buttons["Import OPML"].exists)
		XCTAssertTrue(app.switches["Refresh on Low Data Mode"].exists)

		app.buttons["Feed Notifications"].tap()
		XCTAssertTrue(app.navigationBars["Feed Notifications"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.switches["Dense Discovery"].exists)
		attachScreenshot(named: "platform-delivery-settings")
	}

	func testLongPressFeedAssignsExistingAndCreatesNewFolder() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-sidebar",
			"-reader-reset-reader-state",
		]
		app.launch()

		let feed = app.staticTexts["Stratechery"]
		if feed.waitForExistence(timeout: 2) == false {
			let showSidebar = app.navigationBars.buttons.firstMatch
			XCTAssertTrue(showSidebar.waitForExistence(timeout: 5))
			showSidebar.tap()
		}
		XCTAssertTrue(feed.waitForExistence(timeout: 10))
		feed.press(forDuration: 1.2)
		let editFeed = app.buttons["Edit Feed"]
		XCTAssertTrue(editFeed.waitForExistence(timeout: 5))
		editFeed.tap()

		XCTAssertTrue(app.navigationBars["Edit Feed"].waitForExistence(timeout: 5))
		let designFolder = app.switches["Design"]
		XCTAssertTrue(designFolder.waitForExistence(timeout: 5))
		designFolder.tap()
		let newFolder = app.textFields["new-feed-folder-name"]
		XCTAssertTrue(newFolder.exists)
		newFolder.tap()
		newFolder.typeText("Reading")
		app.buttons["save-feed-folders"].tap()

		XCTAssertTrue(app.staticTexts["Reading"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["Design"].exists)
		XCTAssertFalse(app.navigationBars["Edit Feed"].exists)
		attachScreenshot(named: "feed-folder-edit")
	}

	func testLongPressFolderRenamesAndDeletesFromTheSidebar() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-sidebar",
			"-reader-reset-reader-state",
		]
		app.launch()

		let folder = app.staticTexts["Design"]
		if folder.waitForExistence(timeout: 2) == false {
			let showSidebar = app.navigationBars.buttons.firstMatch
			XCTAssertTrue(showSidebar.waitForExistence(timeout: 5))
			showSidebar.tap()
		}
		XCTAssertTrue(folder.waitForExistence(timeout: 10))
		folder.press(forDuration: 1.2)

		let renameFolder = app.buttons["Rename Folder"]
		XCTAssertTrue(renameFolder.waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Delete Folder"].exists)
		renameFolder.tap()

		XCTAssertTrue(app.navigationBars["Rename Folder"].waitForExistence(timeout: 5))
		let nameField = app.textFields["rename-folder-name"]
		XCTAssertTrue(nameField.waitForExistence(timeout: 5))
		XCTAssertEqual(nameField.value as? String, "Design")
		app.buttons["Cancel"].tap()
		XCTAssertFalse(app.navigationBars["Rename Folder"].waitForExistence(timeout: 2))

		XCTAssertTrue(folder.waitForExistence(timeout: 5))
		folder.press(forDuration: 1.2)
		let deleteFolder = app.buttons["Delete Folder"]
		XCTAssertTrue(deleteFolder.waitForExistence(timeout: 5))
		deleteFolder.tap()
		let confirmDelete = app.buttons["confirm-delete-folder"].exists
			? app.buttons["confirm-delete-folder"]
			: app.buttons["Delete Folder"]
		XCTAssertTrue(confirmDelete.waitForExistence(timeout: 5))
		confirmDelete.tap()

		XCTAssertFalse(app.staticTexts["Design"].waitForExistence(timeout: 2))
		XCTAssertTrue(app.staticTexts["Dense Discovery"].waitForExistence(timeout: 5))
		attachScreenshot(named: "folder-sidebar-actions")
	}

	func testAccessibilityTextKeepsCoreReadingActionsReachable() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-article",
			"-reader-reset-reader-state",
			"-UIPreferredContentSizeCategoryName",
			"UICTContentSizeCategoryAccessibilityXL",
		]
		app.launch()

		XCTAssertTrue(app.staticTexts["Designing calmer tools for people who read every day"].waitForExistence(timeout: 15))
		XCTAssertFalse(app.buttons["Find in Article"].exists)
		XCTAssertFalse(app.buttons["Next Unread"].exists)
		XCTAssertTrue(app.descendants(matching: .any)["article-back-to-feed"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.descendants(matching: .any)["article-reader-controls"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Share"].exists)
		let readButton = app.buttons["Mark unread"].exists ? app.buttons["Mark unread"] : app.buttons["Mark read"]
		XCTAssertTrue(readButton.exists)
		XCTAssertFalse(app.buttons["Unstar"].exists)
		XCTAssertFalse(app.buttons["Star"].exists)
		XCTAssertTrue(app.buttons["More like this"].exists)
		XCTAssertTrue(app.buttons["Share to Readwise"].exists)
		XCTAssertFalse(app.buttons["Larger text"].exists)
		XCTAssertFalse(app.buttons["Smaller text"].exists)
		attachScreenshot(named: "accessibility-large-text-reader")
	}

	func testArticleReaderKeepsActionsOnTheBottomBar() throws {
		XCTAssertTrue(app.staticTexts["Designing calmer tools for people who read every day"].waitForExistence(timeout: 15))
		XCTAssertTrue(app.descendants(matching: .any)["article-reader-controls"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Share"].exists)
		XCTAssertTrue(app.buttons["More like this"].exists)
		XCTAssertTrue(app.buttons["Share to Readwise"].exists)
		XCTAssertFalse(app.buttons["Star"].exists)
		XCTAssertFalse(app.buttons["Unstar"].exists)
		attachScreenshot(named: "article-bottom-controls")
	}

	func testBackFromOpenedArticleReturnsToTheFeed() throws {
		XCTAssertTrue(app.staticTexts["Designing calmer tools for people who read every day"].waitForExistence(timeout: 15))
		let back = app.descendants(matching: .any)["article-back-to-feed"]
		XCTAssertTrue(back.waitForExistence(timeout: 5))
		back.tap()

		let feed = app.descendants(matching: .any)["article-list"]
		XCTAssertTrue(feed.waitForExistence(timeout: 5) || app.buttons["Filter"].waitForExistence(timeout: 5))
		attachScreenshot(named: "back-from-article-to-feed")
	}

	func testLeadingEdgeSwipeFromOpenedArticleReturnsToTheFeed() throws {
		let reader = app.scrollViews["article-reader-scroll-view"]
		XCTAssertTrue(reader.waitForExistence(timeout: 5))
		XCTAssertTrue(app.descendants(matching: .any)["article-back-to-feed"].waitForExistence(timeout: 5))

		let start = reader.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.45))
		let end = reader.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.45))
		start.press(forDuration: 0.05, thenDragTo: end)

		let feed = app.descendants(matching: .any)["article-list"]
		XCTAssertTrue(
			feed.waitForExistence(timeout: 5) || app.buttons["Filter"].waitForExistence(timeout: 5),
			"A leading-edge swipe must return to the feed, not only the back button",
		)
		attachScreenshot(named: "swipe-back-from-article-to-feed")
	}

	func testReaderBoundarySwipeMovesWithinDisplayedCollection() throws {
		let reader = app.scrollViews["article-reader-scroll-view"]
		XCTAssertTrue(reader.waitForExistence(timeout: 5))
		// On iPad, the article list remains visible beside the reader. Scope the
		// assertions to the reader so a visible list row is not mistaken for the
		// currently selected article.
		let nextTitle = reader.staticTexts["A short note on cities, attention, and useful density"]
		let currentTitle = reader.staticTexts["Designing calmer tools for people who read every day"]
		XCTAssertFalse(nextTitle.exists)

		reader.swipeUp()
		XCTAssertFalse(nextTitle.exists, "An ordinary scroll that starts away from the boundary must not navigate")

		// First reach the bottom of the long sample article. The next fresh upward
		// swipe starts at that boundary and selects the next displayed article.
		for _ in 0..<11 where nextTitle.exists == false {
			reader.swipeUp()
		}

		if nextTitle.waitForExistence(timeout: 1) == false {
			// Use one explicit touch drag after reaching the bottom so this test
			// exercises the reader's boundary recognizer, not a programmatic route.
			let start = reader.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
			let end = reader.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
			start.press(forDuration: 0.1, thenDragTo: end)
		}

		XCTAssertTrue(nextTitle.waitForExistence(timeout: 5))
		XCTAssertFalse(currentTitle.exists)

		reader.swipeDown()

		XCTAssertTrue(currentTitle.waitForExistence(timeout: 5))
		XCTAssertFalse(nextTitle.exists)
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

	private func openSettings() {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-sidebar",
			"-reader-reset-reader-state",
		]
		app.launch()
		let back = app.buttons.firstMatch
		XCTAssertTrue(back.waitForExistence(timeout: 5))
		back.tap()
		let settings = app.descendants(matching: .any)["Settings"]
		XCTAssertTrue(settings.waitForExistence(timeout: 5))
		settings.tap()
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
