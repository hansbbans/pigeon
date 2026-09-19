import XCTest

@MainActor
final class PigeonReaderUITests: XCTestCase {
	private var app: XCUIApplication!

	private var articleList: XCUIElement {
		app.collectionViews.matching(NSPredicate(format: "identifier BEGINSWITH %@", "collection-pane-")).firstMatch
	}

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

	override func tearDown() async throws {
		if (testRun?.failureCount ?? 0) > 0 {
			let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
			screenshot.name = "Reader failure"
			screenshot.lifetime = .keepAlways
			add(screenshot)
			if app.state == .runningForeground {
				let hierarchy = XCTAttachment(string: app.debugDescription)
				hierarchy.name = "Reader accessibility hierarchy"
				hierarchy.lifetime = .keepAlways
				add(hierarchy)
			}
		}
	}

	func testTodayLoadsWithoutRefreshAndShowsLiveUnreadCount() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-today-data",
			"-reader-reset-reader-state",
		]
		app.launch()

		let list = articleList
		XCTAssertTrue(list.waitForExistence(timeout: 10))
		XCTAssertTrue(app.navigationBars["Today (2)"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.staticTexts["Loading stories"].exists)
		let firstStory = app.buttons.containing(NSPredicate(
			format: "label CONTAINS %@",
			"Designing calmer tools for people who read every day",
		)).firstMatch
		XCTAssertTrue(firstStory.waitForExistence(timeout: 5))
		attachScreenshot(named: "today-loaded-unread-count")

		firstStory.press(forDuration: 1)
		let markRead = app.buttons["Mark Read"]
		XCTAssertTrue(markRead.waitForExistence(timeout: 5))
		markRead.tap()
		XCTAssertTrue(app.navigationBars["Today (1)"].waitForExistence(timeout: 5))

		let more = app.buttons["article-list-more"]
		XCTAssertTrue(more.waitForExistence(timeout: 5))
		more.tap()
		let readActions = app.buttons["Read actions"]
		XCTAssertTrue(readActions.waitForExistence(timeout: 5))
		readActions.tap()
		let markAll = app.buttons["Mark All as Read"]
		XCTAssertTrue(markAll.waitForExistence(timeout: 5))
		markAll.tap()
		XCTAssertTrue(app.navigationBars["Today (0)"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.staticTexts["Loading stories"].exists)
		attachScreenshot(named: "today-zero-unread-count")
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

	func testFolderMarkAllReadClearsEveryFeedBadge() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data", "-reader-folder-read-data",
			"-reader-show-sidebar", "-reader-reset-reader-state",
		]
		app.launch()

		let firstFeed = app.buttons["Dense Discovery"]
		let secondFeed = app.buttons["Marginal Revolution"]
		let unrelatedFeed = app.buttons["Stratechery"]
		XCTAssertTrue(revealSidebar(containing: firstFeed))
		XCTAssertEqual(firstFeed.value as? String, "1 unread")
		XCTAssertEqual(secondFeed.value as? String, "1 unread")
		XCTAssertEqual(unrelatedFeed.value as? String, "1 unread")
		attachScreenshot(named: "folder-feed-badges-before-mark-all")

		app.staticTexts["Design"].tap()
		XCTAssertTrue(app.navigationBars["Design"].firstMatch.waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["Designing calmer tools for people who read every day"].waitForExistence(timeout: 5))
		let more = app.buttons["article-list-more"]
		XCTAssertTrue(more.waitForExistence(timeout: 5))
		more.tap()
		let readActions = app.buttons["Read actions"]
		XCTAssertTrue(readActions.waitForExistence(timeout: 5))
		readActions.tap()
		let markAll = app.buttons["Mark All as Read"]
		XCTAssertTrue(markAll.waitForExistence(timeout: 5))
		markAll.tap()

		if firstFeed.exists == false, app.buttons["Show Sidebar"].exists {
			app.buttons["Show Sidebar"].tap()
		}
		XCTAssertTrue(revealSidebar(containing: firstFeed))
		let cleared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "0 unread"), object: firstFeed)
		XCTAssertEqual(XCTWaiter.wait(for: [cleared], timeout: 5), .completed)
		attachScreenshot(named: "folder-feed-badges-after-mark-all")
		XCTAssertEqual(firstFeed.value as? String, "0 unread")
		XCTAssertEqual(secondFeed.value as? String, "0 unread")
		XCTAssertEqual(unrelatedFeed.value as? String, "1 unread")
	}

	func testLinkedImageOpensZoomViewer() throws {
		try tapLinkedImage()
		app.buttons["View image"].tap()
		XCTAssertTrue(app.navigationBars["Article image"].waitForExistence(timeout: 5))
		attachScreenshot(named: "linked-image-zoom")
	}

	func testImageViewerZoomAndCloseAreAvailableWithoutGestures() throws {
		app.terminate()
		app.launchArguments += ["-reader-image-fixture"]
		app.launch()
		try tapLinkedImage()
		app.buttons["View image"].tap()
		let close = app.buttons["image-viewer-close"]
		XCTAssertTrue(close.waitForExistence(timeout: 5))
		let zoomIn = app.buttons["image-viewer-zoom-in"]
		XCTAssertTrue(zoomIn.waitForExistence(timeout: 5))
		zoomIn.tap()
		let reset = app.buttons["image-viewer-reset-zoom"]
		let zoomed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: reset)
		XCTAssertEqual(XCTWaiter.wait(for: [zoomed], timeout: 5), .completed)
		app.swipeDown()
		XCTAssertTrue(close.exists, "Panning a zoomed image must keep the viewer open")
		reset.tap()
		close.tap()
		XCTAssertTrue(app.scrollViews["article-reader-scroll-view"].waitForExistence(timeout: 5))
	}

	func testImageViewerDoubleTapZoomsAndFittedImageCanDismissDownward() throws {
		app.terminate()
		app.launchArguments += ["-reader-image-fixture"]
		app.launch()
		try tapLinkedImage()
		app.buttons["View image"].tap()
		let image = app.descendants(matching: .any)["image-viewer-image"]
		XCTAssertTrue(image.waitForExistence(timeout: 5))
		image.doubleTap()
		let reset = app.buttons["image-viewer-reset-zoom"]
		let zoomed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: reset)
		XCTAssertEqual(XCTWaiter.wait(for: [zoomed], timeout: 5), .completed)
		reset.tap()
		let fitted = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == false"), object: reset)
		XCTAssertEqual(XCTWaiter.wait(for: [fitted], timeout: 5), .completed)
		image.swipeDown()
		let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["image-viewer-close"])
		XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 5), .completed)
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

	func testYouTubeArticleShowsEmbeddedPlayerAndOpenFallback() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-youtube",
			"-reader-reset-reader-state",
		]
		app.launch()

		XCTAssertTrue(app.staticTexts["A practical guide to making better videos"].waitForExistence(timeout: 15))
		XCTAssertTrue(app.otherElements["youtube-player-dQw4w9WgXcQ"].waitForExistence(timeout: 10))
		let playerWebView = app.webViews["youtube-webview-dQw4w9WgXcQ"]
		XCTAssertTrue(playerWebView.waitForExistence(timeout: 10))
		XCTAssertGreaterThanOrEqual(playerWebView.frame.height, 200)
		XCTAssertTrue(app.buttons["Open in YouTube"].waitForExistence(timeout: 5))
		// The embedded WKWebView may show YouTube's player or its local failure
		// surface depending on network availability; either path keeps the
		// explicit Open in YouTube action available.
		attachScreenshot(named: "youtube-player")
	}

	func testAddFeedSearchSelectsAndSavesYouTubeChannel() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-add-feed",
			"-reader-reset-reader-state",
		]
		app.launch()

		XCTAssertTrue(app.navigationBars["Add Feed"].waitForExistence(timeout: 10))
		let field = app.textFields["add-feed-url"]
		XCTAssertTrue(field.waitForExistence(timeout: 5))
		field.tap()
		field.typeText("mkbhd")

		let result = app.buttons["youtube-channel-result-UCBJycsmduvYEL83R_U4JriQ"]
		XCTAssertTrue(result.waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Marques Brownlee"].exists)
		XCTAssertTrue(app.staticTexts["@mkbhd"].exists)
		let add = app.buttons["add-feed"]
		XCTAssertFalse(add.isEnabled)
		result.tap()
		XCTAssertTrue(add.isEnabled)

		// Editing the query removes the prior selection/results before the next
		// debounced response can arrive.
		field.tap()
		field.typeText("x")
		XCTAssertFalse(result.exists)
		XCTAssertFalse(add.isEnabled)
		field.typeText(XCUIKeyboardKey.delete.rawValue)
		XCTAssertTrue(result.waitForExistence(timeout: 10))

		result.tap()
		XCTAssertTrue(add.isEnabled)
		let folder = app.textFields["add-feed-new-folder"]
		XCTAssertTrue(folder.waitForExistence(timeout: 5))
		folder.tap()
		folder.typeText("Creators")
		add.tap()

		XCTAssertTrue(app.navigationBars["For You"].waitForExistence(timeout: 10))
		attachScreenshot(named: "youtube-channel-search-add")
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

	func testSidebarAddFeedOpensTheSubscribeSheet() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-sidebar",
			"-reader-reset-reader-state",
		]
		app.launch()

		let addFeed = app.descendants(matching: .any)["add-feed"]
		XCTAssertTrue(revealSidebar(containing: addFeed))
		addFeed.tap()

		XCTAssertTrue(app.navigationBars["Add Feed"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.textFields["add-feed-url"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Add"].exists)
		app.buttons["Cancel"].tap()
		XCTAssertTrue(app.navigationBars["Add Feed"].waitForNonExistence(timeout: 3))
		attachScreenshot(named: "sidebar-add-feed")
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
		XCTAssertTrue(revealSidebar(containing: feed))
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
		XCTAssertTrue(revealSidebar(containing: folder))
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
		let confirmDelete = app.buttons["confirm-delete-folder"].firstMatch.exists
			? app.buttons["confirm-delete-folder"].firstMatch
			: app.buttons["Delete Folder"].firstMatch
		XCTAssertTrue(confirmDelete.waitForExistence(timeout: 5))
		confirmDelete.tap()

		XCTAssertFalse(app.staticTexts["Design"].waitForExistence(timeout: 2))
		XCTAssertTrue(app.staticTexts["Dense Discovery"].waitForExistence(timeout: 5))
		attachScreenshot(named: "folder-sidebar-actions")
	}

	func testRenameFolderValidationErrorStaysVisibleInTheSheet() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-sidebar",
			"-reader-reset-reader-state",
		]
		app.launch()

		let folder = app.staticTexts["Design"]
		XCTAssertTrue(revealSidebar(containing: folder))
		folder.press(forDuration: 1.2)
		let renameFolder = app.buttons["Rename Folder"]
		XCTAssertTrue(renameFolder.waitForExistence(timeout: 5))
		renameFolder.tap()

		XCTAssertTrue(app.navigationBars["Rename Folder"].waitForExistence(timeout: 5))
		let nameField = app.textFields["rename-folder-name"]
		XCTAssertTrue(nameField.waitForExistence(timeout: 5))
		nameField.doubleTap()
		nameField.typeText("Technology")
		app.buttons["Save"].tap()

		XCTAssertTrue(app.staticTexts["A folder with that name already exists."].waitForExistence(timeout: 5))
		XCTAssertTrue(app.otherElements["library-editor-error"].exists)
		XCTAssertTrue(app.navigationBars["Rename Folder"].exists)
	}

	func testLongPressFeedOffersRenameAndUnsubscribe() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-sidebar",
			"-reader-reset-reader-state",
		]
		app.launch()

		let feed = app.staticTexts["Stratechery"]
		XCTAssertTrue(revealSidebar(containing: feed))
		feed.press(forDuration: 1.2)

		let renameFeed = app.buttons["Rename Feed"]
		XCTAssertTrue(renameFeed.waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Unsubscribe"].exists)
		renameFeed.tap()

		XCTAssertTrue(app.navigationBars["Rename Feed"].waitForExistence(timeout: 5))
		let nameField = app.textFields["rename-feed-name"]
		XCTAssertTrue(nameField.waitForExistence(timeout: 5))
		XCTAssertEqual(nameField.value as? String, "Stratechery")
		app.buttons["Cancel"].tap()
		XCTAssertFalse(app.navigationBars["Rename Feed"].waitForExistence(timeout: 2))

		XCTAssertTrue(feed.waitForExistence(timeout: 5))
		feed.press(forDuration: 1.2)
		let unsubscribe = app.buttons["Unsubscribe"]
		XCTAssertTrue(unsubscribe.waitForExistence(timeout: 5))
		unsubscribe.tap()
		let confirm = app.buttons["confirm-unsubscribe-feed"].firstMatch.exists
			? app.buttons["confirm-unsubscribe-feed"].firstMatch
			: app.buttons["Unsubscribe"].firstMatch
		XCTAssertTrue(confirm.waitForExistence(timeout: 5))
		confirm.tap()

		XCTAssertFalse(app.staticTexts["Stratechery"].waitForExistence(timeout: 2))
		XCTAssertTrue(app.staticTexts["For You"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["Design"].waitForExistence(timeout: 5))
		attachScreenshot(named: "feed-sidebar-actions")
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

	func testFeedRowLeadingSwipeKeepsReadAction() throws {
		try launchFeedList()

		let article = app.staticTexts["Designing calmer tools for people who read every day"]
		XCTAssertTrue(article.waitForExistence(timeout: 10))
		article.swipeRight()

		XCTAssertTrue(app.buttons["Mark Read"].waitForExistence(timeout: 5))
	}

	func testManualReadOffersUndoAndRestoresTheStory() throws {
		try launchFeedList()
		let title = "Designing calmer tools for people who read every day"
		app.staticTexts[title].swipeRight()
		app.buttons["Mark Read"].tap()
		let undo = app.buttons["reader-undo-action"]
		XCTAssertTrue(undo.waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["Marked read"].exists)
		undo.tap()
		XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 5))
		XCTAssertFalse(app.buttons["reader-undo-action"].exists)
	}

	func testReaderStarCanBeUndoneWithoutLeavingTheStory() throws {
		app.buttons["article-reader-more"].tap()
		let unstar = app.buttons["Unstar"]
		XCTAssertTrue(unstar.waitForExistence(timeout: 5))
		unstar.tap()
		XCTAssertTrue(app.buttons["reader-undo-action"].waitForExistence(timeout: 5))
		app.buttons["reader-undo-action"].tap()
		XCTAssertTrue(app.scrollViews["article-reader-scroll-view"].exists)
		app.buttons["article-reader-more"].tap()
		XCTAssertTrue(app.buttons["Unstar"].waitForExistence(timeout: 5))
	}

	func testOlderStoriesLoadAsTheListApproachesItsEnd() throws {
		launchPagingFixture()
		let nextPage = app.staticTexts["Paging story 13"]
		for _ in 0..<12 {
			if nextPage.isHittable { break }
			app.swipeUp()
		}
		XCTAssertTrue(nextPage.waitForExistence(timeout: 10))
		XCTAssertTrue(nextPage.isHittable)
	}

	func testReturningToTheListKeepsTheSameRowPosition() throws {
		launchPagingFixture()
		let story = app.staticTexts["Paging story 10"]
		for _ in 0..<8 {
			if story.isHittable { break }
			app.swipeUp()
		}
		XCTAssertTrue(story.isHittable)
		let previousY = story.frame.minY
		story.tap()
		XCTAssertTrue(app.scrollViews["article-reader-scroll-view"].waitForExistence(timeout: 5))
		// Compact navigation needs Back; iPad can keep both columns visible.
		if app.buttons["article-list-more"].isHittable == false {
			let back = app.buttons["article-back-to-feed"]
			XCTAssertTrue(back.waitForExistence(timeout: 5))
			back.tap()
		}
		let restored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
			story.isHittable && abs(story.frame.minY - previousY) < 4
		}, object: nil)
		XCTAssertEqual(XCTWaiter.wait(for: [restored], timeout: 5), .completed)
	}

	private func launchPagingFixture() {
		app.terminate()
		app.launchArguments = ["-reader-sample-data", "-reader-paging-fixture", "-reader-reset-reader-state"]
		app.launch()
		XCTAssertTrue(app.staticTexts["Paging story 1"].waitForExistence(timeout: 10))
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

	func testFeedRowTrailingSwipeOffersSaveAndStarActions() throws {
		try launchFeedList()

		let article = app.staticTexts["Designing calmer tools for people who read every day"]
		XCTAssertTrue(article.waitForExistence(timeout: 10))
		article.swipeLeft()

		XCTAssertTrue(app.buttons["Save to Reader"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["Unstar"].exists)
	}

	func testFeedRowSaveErrorIsVisible() throws {
		try launchFeedList()

		let article = app.staticTexts["Designing calmer tools for people who read every day"]
		XCTAssertTrue(article.waitForExistence(timeout: 10))
		article.swipeLeft()
		app.buttons["Save to Reader"].tap()

		XCTAssertTrue(app.staticTexts["Add a Readwise access token in Settings before saving links."].waitForExistence(timeout: 5))
	}

	func testFeedRowSuccessfulSaveKeepsTheListInteractive() throws {
		try launchFeedList(additionalArguments: ["-reader-save-success"])

		let article = app.staticTexts["Designing calmer tools for people who read every day"]
		article.swipeLeft()
		app.buttons["Save to Reader"].tap()

		XCTAssertTrue(app.staticTexts["Saved to Reader"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.alerts.firstMatch.exists)
		app.buttons["Dismiss confirmation"].tap()
		article.tap()
		XCTAssertTrue(app.scrollViews["article-reader-scroll-view"].waitForExistence(timeout: 5))
	}

	func testListMoreMenuKeepsSecondaryActionsReachable() throws {
		try launchFeedList()
		app.buttons["article-list-more"].tap()

		XCTAssertTrue(app.buttons["article-list-sort"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["article-list-density"].exists)
		XCTAssertTrue(app.buttons["Read actions"].exists)
		XCTAssertTrue(app.buttons["Refresh"].exists)
		app.buttons["Settings"].tap()
		XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
	}

	func testInlineSuccessfulSaveDoesNotInterruptReading() throws {
		app.terminate()
		app.launchArguments += ["-reader-save-success"]
		app.launch()
		try tapNormalLink()
		app.buttons["Share to Reader"].tap()

		XCTAssertTrue(app.staticTexts["Saved to Reader"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.alerts.firstMatch.exists)
		XCTAssertTrue(app.scrollViews["article-reader-scroll-view"].exists)
	}

	func testReadingControlsSheetReturnsToTheOpenArticle() throws {
		app.buttons["reader-reading-controls"].tap()
		XCTAssertTrue(app.navigationBars["Reading controls"].waitForExistence(timeout: 5))
		app.buttons["Increase text size"].tap()
		app.buttons["Done"].tap()

		let reader = app.scrollViews["article-reader-scroll-view"]
		XCTAssertTrue(reader.waitForExistence(timeout: 5))
		XCTAssertTrue(reader.staticTexts["Designing calmer tools for people who read every day"].exists)
		XCTAssertFalse(app.navigationBars["Reading controls"].exists)
	}

	func testReaderMoreMenuProvidesAnAlternativeToThePullGesture() throws {
		app.buttons["article-reader-more"].tap()
		app.buttons["Next story"].tap()
		let reader = app.scrollViews["article-reader-scroll-view"]
		XCTAssertTrue(reader.staticTexts["A short note on cities, attention, and useful density"].waitForExistence(timeout: 5))
	}

	func testSearchSurvivesOpeningAnArticleOnCompact() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-reset-reader-state",
		]
		app.launch()

		let forYou = app.staticTexts["For You"]
		if forYou.waitForExistence(timeout: 3) {
			forYou.tap()
		}
		let list = articleList
		XCTAssertTrue(list.waitForExistence(timeout: 10) || app.searchFields.firstMatch.waitForExistence(timeout: 10))

		let search = app.searchFields.firstMatch
		XCTAssertTrue(search.waitForExistence(timeout: 10))
		search.tap()
		search.typeText("calmer")
		let result = app.staticTexts["Designing calmer tools for people who read every day"]
		XCTAssertTrue(result.waitForExistence(timeout: 10))
		result.tap()

		let back = app.descendants(matching: .any)["article-back-to-feed"]
		XCTAssertTrue(back.waitForExistence(timeout: 5))
		back.tap()

		XCTAssertTrue(search.waitForExistence(timeout: 5))
		let query = (search.value as? String) ?? search.placeholderValue
		XCTAssertTrue(
			search.value as? String == "calmer" || app.staticTexts["calmer"].exists,
			"Opening a compact article must not remount the list and clear search. Observed: \(String(describing: query))",
		)
		attachScreenshot(named: "search-survives-compact-article")
	}

	func testBackFromOpenedArticleReturnsToTheFeed() throws {
		XCTAssertTrue(app.staticTexts["Designing calmer tools for people who read every day"].waitForExistence(timeout: 15))
		let back = app.descendants(matching: .any)["article-back-to-feed"]
		XCTAssertTrue(back.waitForExistence(timeout: 5))
		back.tap()

		let feed = articleList
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

		let feed = articleList
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

	func testArticleBackSwipeReturnsToFeedView() throws {
		let reader = app.scrollViews["article-reader-scroll-view"]
		XCTAssertTrue(reader.waitForExistence(timeout: 5))

		// A compact NavigationSplitView uses the article as a pushed detail. Start
		// at the reader's leading edge so this exercises the system back gesture,
		// not the reader's vertical boundary navigation.
		let start = reader.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
		let end = reader.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
		start.press(forDuration: 0.1, thenDragTo: end)

		XCTAssertTrue(app.navigationBars["For You"].waitForExistence(timeout: 5))
		XCTAssertFalse(reader.exists)
	}

	func testLongArticleMarksReadOnlyAfterScrollingWithAfterSixtyPercentSetting() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data", "-reader-show-article",
			"-reader-reset-reader-state", "-reader-mark-read-on-scroll",
		]
		app.launch()
		let reader = app.scrollViews["article-reader-scroll-view"]
		XCTAssertTrue(reader.waitForExistence(timeout: 5))
		XCTAssertTrue(reader.staticTexts["The quiet craft of a good reading surface"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.buttons["Mark read"].exists, "Loading the top of a long article must not count as fully read")
		let markedRead = app.buttons["Mark unread"]
		for _ in 0..<3 where markedRead.exists == false {
			reader.swipeUp()
		}
		XCTAssertTrue(markedRead.waitForExistence(timeout: 5), "Reading progress must continue after initial position restoration")
		XCTAssertTrue(reader.staticTexts["Designing calmer tools for people who read every day"].exists)
	}

	func testShortArticleMarksReadAfterBodyLayoutWithAfterSixtyPercentSetting() throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-short-article",
			"-reader-reset-reader-state",
			"-reader-mark-read-on-scroll",
		]
		app.launch()

		XCTAssertTrue(app.staticTexts["A short note on cities, attention, and useful density"].waitForExistence(timeout: 15))
		XCTAssertTrue(app.scrollViews["article-reader-scroll-view"].waitForExistence(timeout: 5))
		XCTAssertTrue(
			app.buttons["Mark unread"].waitForExistence(timeout: 15),
			"A laid-out article that fits onscreen should count as fully read for After 60% Read.",
		)
	}

	private func tapLinkedImage() throws {
		let image = app.images["A notebook beside a cup of coffee"]
		guard waitForHittableReaderTarget(image, description: "the linked fixture image") else { return }
		image.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
	}

	private func launchFeedList(additionalArguments: [String] = []) throws {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-sidebar",
			"-reader-reset-reader-state",
		]
		app.launchArguments += additionalArguments
		app.launch()

		if app.navigationBars["For You"].exists == false {
			let forYou = app.buttons["reader-sidebar-item-forYou"]
			XCTAssertTrue(forYou.waitForExistence(timeout: 5))
			forYou.tap()
		}
		XCTAssertTrue(app.navigationBars["For You"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Designing calmer tools for people who read every day"].waitForExistence(timeout: 10))
	}

	private func openSettings() {
		app.terminate()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-sidebar",
			"-reader-reset-reader-state",
		]
		app.launch()
		let settings = app.descendants(matching: .any)["Settings"]
		XCTAssertTrue(revealSidebar(containing: settings))
		settings.tap()
	}

	private func revealSidebar(containing target: XCUIElement, timeout: TimeInterval = 10) -> Bool {
		let deadline = Date().addingTimeInterval(timeout)
		let backButton = app.buttons["BackButton"]

		while Date() < deadline {
			if target.exists {
				return true
			}
			if backButton.waitForExistence(timeout: 1), backButton.isHittable {
				backButton.tap()
			}
			RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
		}

		return target.exists
	}

	private func tapNormalLink() throws {
		let normalLink = app.links["Read the design notes"]
		guard waitForHittableReaderTarget(normalLink, description: "the normal fixture link") else { return }
		normalLink.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
		XCTAssertFalse(
			app.buttons["View image"].exists || app.buttons["Open link"].exists,
			"The normal-link helper hit the linked-image dialog; the fixture target should be accessible directly.",
		)
	}

	private func waitForHittableReaderTarget(_ target: XCUIElement, description: String) -> Bool {
		let reader = app.scrollViews["article-reader-scroll-view"]
		guard reader.waitForExistence(timeout: 5) else {
			XCTFail("The article reader did not appear while waiting for \(description).")
			return false
		}
		let webView = app.webViews.firstMatch
		guard webView.waitForExistence(timeout: 5) else {
			XCTFail("The article WebView did not appear while waiting for \(description).")
			return false
		}
		let deadline = Date().addingTimeInterval(20)
		var lastScrolledTargetFrame: CGRect?

		while Date() < deadline {
			if target.exists {
				// Do not scroll the outer reader until the WebView has reported a
				// full article-sized frame. While it is still collapsed during
				// HTML measurement, a swipe can be interpreted as article-boundary
				// navigation and replace the rich fixture with another article.
				let readerFrame = reader.frame
				let webViewFrame = webView.frame
				let targetFrame = target.frame
				let usableReaderFrame = visibleReaderFrame(reader)
				// Validate the same point we will tap. Requiring the entire image
				// to fit can oscillate between scroll positions even with its center visible.
				let tapPoint = CGPoint(x: targetFrame.midX, y: targetFrame.midY)
				let targetIsUsable = targetFrame.isEmpty == false
					&& target.isHittable && usableReaderFrame.contains(tapPoint)
				if targetIsUsable, webViewFrame.contains(tapPoint) {
					return true
				}
				if webViewFrame.height > readerFrame.height, targetFrame.isEmpty == false {
					if targetFrame.maxY > usableReaderFrame.maxY {
						if lastScrolledTargetFrame != targetFrame {
							reader.swipeUp()
							lastScrolledTargetFrame = targetFrame
						}
					} else if targetFrame.minY < usableReaderFrame.minY {
						if lastScrolledTargetFrame != targetFrame {
							reader.swipeDown()
							lastScrolledTargetFrame = targetFrame
						}
					}
				}
			}

			RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
		}

		XCTFail("Timed out waiting for \(description) to finish rendering and become hittable.")
		return false
	}

	private func visibleReaderFrame(_ reader: XCUIElement) -> CGRect {
		var frame = reader.frame
		let controls = app.otherElements["article-reader-controls"]
		guard controls.exists else { return frame }
		let controlsFrame = controls.frame
		guard controlsFrame.minY > frame.minY, controlsFrame.minY < frame.maxY else { return frame }
		frame.size.height = controlsFrame.minY - frame.minY
		return frame
	}

	private func attachScreenshot(named name: String) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}
}

/// Launch-order proofs for the opt-in DEBUG real-model fixture. Each test waits
/// for visible ArticleList content while the fixture's /sync request remains
/// held for 30 seconds; no refresh action is used to make the content appear.
@MainActor
final class PigeonReaderRealStartupUITests: XCTestCase {
	private var app: XCUIApplication!

	private var articleList: XCUIElement {
		app.collectionViews.matching(NSPredicate(format: "identifier BEGINSWITH %@", "collection-pane-")).firstMatch
	}

	override func setUp() async throws {
		continueAfterFailure = false
		app = XCUIApplication()
		XCUIDevice.shared.orientation = .portrait
	}

	override func tearDown() async throws {
		if (testRun?.failureCount ?? 0) > 0 {
			let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
			screenshot.name = "Startup failure"
			screenshot.lifetime = .keepAlways
			add(screenshot)
			if app.state == .runningForeground {
				let hierarchy = XCTAttachment(string: app.debugDescription)
				hierarchy.name = "Startup accessibility hierarchy"
				hierarchy.lifetime = .keepAlways
				add(hierarchy)
			}
		}
	}

	func testEmptyColdTodayShowsArticleBeforeFullSyncCompletes() throws {
		launch()
		assertHomeIsVisible()
		app.buttons["Today"].tap()

		let story = app.staticTexts["Cold-start story appears before sync finishes"]
		XCTAssertTrue(story.waitForExistence(timeout: 8))
		XCTAssertTrue(app.navigationBars["Today (1)"].waitForExistence(timeout: 2))
		XCTAssertTrue(articleList.exists)
		XCTAssertFalse(app.staticTexts["Loading stories"].exists)
		attachScreenshot(named: "real-startup-empty-cold-today-before-sync")
	}

	func testCachedSelectedListShowsSavedArticlesDuringSlowSync() throws {
		launch(with: "-reader-real-startup-cached-selected-list")
		assertHomeIsVisible()
		let todayCount = XCTNSPredicateExpectation(
			predicate: NSPredicate(format: "value == %@", "2 unread"),
			object: app.buttons["Today"],
		)
		XCTAssertEqual(XCTWaiter.wait(for: [todayCount], timeout: 5), .completed)
		attachScreenshot(named: "home-live-counts-before-sync")
		let feed = app.buttons["Launch Fixture Reads"]
		XCTAssertTrue(feed.waitForExistence(timeout: 5))
		feed.tap()

		let firstStory = app.staticTexts["Saved story remains visible during slow updates"]
		XCTAssertTrue(firstStory.waitForExistence(timeout: 8))
		XCTAssertTrue(app.staticTexts["A second saved story proves the list is real"].exists)
		XCTAssertFalse(app.staticTexts["Loading stories"].exists)
		attachScreenshot(named: "real-startup-cached-selected-list-during-sync")
	}

	func testReplayFailureKeepsCachedArticlesVisible() throws {
		launch(with: "-reader-real-startup-replay-failure")
		assertHomeIsVisible()
		XCTAssertTrue(app.staticTexts["Launch fixture replay failed (503)."].waitForExistence(timeout: 8))
		let feed = app.buttons["Launch Fixture Reads"]
		XCTAssertTrue(feed.waitForExistence(timeout: 5))
		feed.tap()

		let visibleStory = app.staticTexts["A second saved story proves the list is real"]
		XCTAssertTrue(visibleStory.waitForExistence(timeout: 8))
		XCTAssertFalse(app.staticTexts["Saved story remains visible during slow updates"].exists)
		XCTAssertFalse(app.staticTexts["Loading stories"].exists)
		attachScreenshot(named: "real-startup-replay-failure-with-cached-list")
	}

	func testForYouLoadsFromHomeBeforeFullSyncCompletes() throws {
		launch()
		assertHomeIsVisible()
		app.buttons["For You"].tap()

		let story = app.staticTexts["Cold-start story appears before sync finishes"]
		XCTAssertTrue(story.waitForExistence(timeout: 8))
		XCTAssertTrue(articleList.exists)
		XCTAssertFalse(app.staticTexts["Loading stories"].exists)
		attachScreenshot(named: "real-startup-for-you-from-home")
	}

	func testCachedStartupShowsSavedHomeBeforeFullHydration() throws {
		XCUIDevice.shared.orientation = .portrait
		assertCachedStartupShowsSavedHomeBeforeFullHydration()
	}

	func testIPadLandscapeStartupShowsSavedHomeBeforeFullHydration() throws {
		try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad landscape startup coverage")
		XCUIDevice.shared.orientation = .landscapeLeft
		defer { XCUIDevice.shared.orientation = .portrait }
		assertCachedStartupShowsSavedHomeBeforeFullHydration()
	}

	private func assertCachedStartupShowsSavedHomeBeforeFullHydration(file: StaticString = #filePath, line: UInt = #line) {
		app.launchArguments = [
			"-reader-real-startup", "-reader-real-startup-cached-selected-list",
			"-reader-delay-initial-snapshot", "-reader-reset-reader-state",
		]
		app.launch()
		attachScreenshot(named: "cached-startup-before-disk-restore")

		let loading = app.descendants(matching: .any)["library-startup-loading"].firstMatch
		let homes = app.buttons.matching(identifier: "For You")
		XCTAssertTrue(homes.firstMatch.waitForExistence(timeout: 2), file: file, line: line)
		guard let home = homes.allElementsBoundByIndex.first(where: { $0.isHittable }) else {
			return XCTFail("The saved Home control is not visible.", file: file, line: line)
		}
		XCTAssertTrue(home.isHittable, file: file, line: line)
		XCTAssertFalse(loading.exists, file: file, line: line)
		XCTAssertFalse(app.staticTexts["No recommendations yet"].exists, file: file, line: line)
		XCTAssertFalse(app.staticTexts["No stories yet"].exists, file: file, line: line)

		let feeds = app.buttons.matching(identifier: "Launch Fixture Reads")
		XCTAssertTrue(feeds.firstMatch.waitForExistence(timeout: 2), file: file, line: line)
		// The landscape split view remains mounted beneath Home. Interact
		// with the visible control instead of an offscreen duplicate.
		guard let feed = feeds.allElementsBoundByIndex.first(where: { $0.isHittable }) else {
			return XCTFail("The saved feed is not available on Home.", file: file, line: line)
		}
		XCTAssertFalse(loading.exists, file: file, line: line)
		XCTAssertEqual(feed.value as? String, "2 unread", file: file, line: line)
		XCTAssertTrue(app.buttons.matching(identifier: "For You").allElementsBoundByIndex.contains(where: { $0.isHittable }), file: file, line: line)
		attachScreenshot(named: "cached-startup-home-with-saved-feeds")
		feed.tap()
		XCTAssertTrue(app.staticTexts["Loading stories"].waitForExistence(timeout: 2), file: file, line: line)
		XCTAssertTrue(
			app.staticTexts["Saved story remains visible during slow updates"].waitForExistence(timeout: 20),
			file: file, line: line,
		)
		XCTAssertTrue(app.staticTexts["A second saved story proves the list is real"].exists, file: file, line: line)
		attachScreenshot(named: "cached-startup-saved-stories-before-network-sync")
	}

	private func assertHomeIsVisible(file: StaticString = #filePath, line: UInt = #line) {
		// The loading screen shares the Pigeon title, so wait for an actual
		// Home control before checking that startup has completed.
		let homeReady = XCTNSPredicateExpectation(
			predicate: NSPredicate(format: "isHittable == true"),
			object: app.buttons["For You"],
		)
		XCTAssertEqual(XCTWaiter.wait(for: [homeReady], timeout: 8), .completed, file: file, line: line)
		XCTAssertTrue(app.buttons["Today"].isHittable, file: file, line: line)
		XCTAssertFalse(app.scrollViews["article-reader-scroll-view"].exists, file: file, line: line)
		attachScreenshot(named: "home-on-launch")
	}

	private func launch(with extraArgument: String? = nil) {
		var arguments = ["-reader-real-startup", "-reader-reset-reader-state"]
		if let extraArgument {
			arguments.append(extraArgument)
		}
		app.launchArguments = arguments
		app.launch()
	}

	private func attachScreenshot(named name: String) {
		let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}
}
