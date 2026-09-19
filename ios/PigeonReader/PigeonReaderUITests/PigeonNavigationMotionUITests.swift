import XCTest

@MainActor
final class PigeonNavigationMotionUITests: XCTestCase {
	private var app: XCUIApplication!

	override func setUp() async throws {
		continueAfterFailure = false
		app = XCUIApplication()
		launchFixture()
	}

	override func tearDown() async throws {
		if (testRun?.failureCount ?? 0) > 0 {
			let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
			screenshot.name = "Navigation failure"
			screenshot.lifetime = .keepAlways
			add(screenshot)
			if app.state == .runningForeground {
				let hierarchy = XCTAttachment(string: app.debugDescription)
				hierarchy.name = "Navigation accessibility hierarchy"
				hierarchy.lifetime = .keepAlways
				add(hierarchy)
			}
		}
	}

	func testExpandingAndCollapsingKeepsTheFolderInPlace() {
		let toggle = folderToggle(1)
		let originalY = toggle.frame.minY
		toggle.tap()
		XCTAssertTrue(feed(1, 1).waitForExistence(timeout: 5))
		XCTAssertEqual(toggle.frame.minY, originalY, accuracy: 4)
		toggle.tap()
		let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: feed(1, 1))
		XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
		XCTAssertEqual(toggle.frame.minY, originalY, accuracy: 4)
	}

	func testFolderReversalsFinishWithOneVisibleSetOfFeeds() {
		folderToggle(1).tap(withNumberOfTaps: 3, numberOfTouches: 1)
		XCTAssertTrue(feed(1, 1).waitForExistence(timeout: 5))
		XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "reader-sidebar-item-feed/navigation-1-1").count, 1)
		XCTAssertTrue(folderToggle(1).isHittable)
	}

	func testFolderTitleOpensItsNativeCollectionDestination() {
		let folder = app.buttons["reader-sidebar-item-navigation-folder-1"]
		XCTAssertTrue(folder.waitForExistence(timeout: 5))
		folder.tap()
		XCTAssertTrue(app.navigationBars["Folder 01"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["BackButton"].waitForExistence(timeout: 5))
	}

	func testBottomFolderRevealsItsFirstFeedWithoutLosingTheFolder() {
		folderToggle(1).tap()
		let sidebar = app.descendants(matching: .any)["reader-sidebar"].firstMatch
		sidebar.swipeUp()
		let toggle = folderToggle(6)
		XCTAssertTrue(toggle.isHittable)
		let originalY = toggle.frame.minY
		toggle.tap()
		let child = feed(6, 1)
		let visible = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: child)
		XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 5), .completed)
		XCTAssertTrue(toggle.isHittable)
		XCTAssertLessThanOrEqual(abs(toggle.frame.minY - originalY), max(child.frame.height, 44) + 24)
	}

	func testCachedFeedOpensImmediatelyAndSupportsNativeBack() throws {
		folderToggle(1).tap()
		feed(1, 1).tap()
		XCTAssertTrue(app.navigationBars["Feed 01.01"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["Designing calmer tools for people who read every day"].exists)
		XCTAssertFalse(app.descendants(matching: .any)["collection-loading-placeholder"].exists)
		if folderToggle(1).isHittable {
			throw XCTSkip("Native push/back is exercised in compact width; the regular sidebar remains visible.")
		}
		let pane = app.descendants(matching: .any)["collection-pane-feed/navigation-1-1"].firstMatch
		let start = pane.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
		let end = pane.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
		start.press(forDuration: 0.1, thenDragTo: end)
		XCTAssertTrue(folderToggle(1).waitForExistence(timeout: 5))
		XCTAssertTrue(feed(1, 1).isHittable)
	}

	func testUncachedFeedKeepsItsTitleWhileLoadingWithoutAnEmptyFlash() {
		folderToggle(1).tap()
		feed(1, 2).tap()
		XCTAssertTrue(app.navigationBars["Feed 01.02"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.descendants(matching: .any)["collection-loading-placeholder"].waitForExistence(timeout: 1))
		XCTAssertFalse(app.staticTexts["No stories yet"].exists)
		XCTAssertTrue(app.staticTexts["No stories yet"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.navigationBars["Feed 01.02"].exists)
	}

	func testFailedFirstLoadOffersRetryWithTheSameDestination() {
		launchFixture(additionalArguments: ["-reader-navigation-error"])
		folderToggle(1).tap()
		feed(1, 2).tap()
		let retry = app.buttons["collection-retry"]
		XCTAssertTrue(retry.waitForExistence(timeout: 6))
		retry.tap()
		XCTAssertTrue(app.descendants(matching: .any)["collection-loading-placeholder"].waitForExistence(timeout: 1))
		XCTAssertTrue(app.navigationBars["Feed 01.02"].exists)
		XCTAssertFalse(app.staticTexts["No stories yet"].exists)
	}

	func testSwitchingFeedsKeepsTheRegularSidebarStationary() throws {
		folderToggle(1).tap()
		feed(1, 1).tap()
		guard folderToggle(1).isHittable else { throw XCTSkip("Requires a regular-width iPad sidebar") }
		let originalY = folderToggle(1).frame.minY
		feed(1, 3).tap()
		XCTAssertTrue(app.staticTexts["A short note on cities, attention, and useful density"].waitForExistence(timeout: 5))
		XCTAssertEqual(folderToggle(1).frame.minY, originalY, accuracy: 4)
		XCTAssertFalse(app.descendants(matching: .any)["collection-loading-placeholder"].exists)
	}

	func testFeedPreviewDoesNotNavigateUntilOpenFeedIsChosen() {
		folderToggle(1).tap()
		feed(1, 1).press(forDuration: 0.7)
		XCTAssertTrue(app.buttons["Open Feed"].waitForExistence(timeout: 5))
		let previewHeadline = app.descendants(matching: .any).matching(
			NSPredicate(format: "label == %@", "Designing calmer tools for people who read every day")
		).firstMatch
		XCTAssertTrue(previewHeadline.waitForExistence(timeout: 5))
		XCTAssertFalse(app.navigationBars["Feed 01.01"].exists)
		app.buttons["Open Feed"].tap()
		XCTAssertTrue(app.navigationBars["Feed 01.01"].waitForExistence(timeout: 5))
	}

	func testErrorBannerDoesNotMoveSidebarAndCanBeDismissed() {
		folderToggle(1).tap()
		let originalY = folderToggle(1).frame.minY
		feed(1, 1).press(forDuration: 0.7)
		let edit = app.buttons["Edit Feed"]
		XCTAssertTrue(edit.waitForExistence(timeout: 5))
		// The navigation fixture intentionally has no matching editable subscription.
		edit.tap()
		let banner = app.descendants(matching: .any)["reader-error-banner"].firstMatch
		XCTAssertTrue(banner.waitForExistence(timeout: 5))
		XCTAssertEqual(folderToggle(1).frame.minY, originalY, accuracy: 2)
		banner.buttons["Dismiss"].tap()
		XCTAssertTrue(banner.waitForNonExistence(timeout: 5))
		XCTAssertEqual(folderToggle(1).frame.minY, originalY, accuracy: 2)
	}

	func testCancelledBackSwipeKeepsTheFeedAndItsStories() throws {
		folderToggle(1).tap()
		feed(1, 1).tap()
		XCTAssertTrue(app.navigationBars["Feed 01.01"].waitForExistence(timeout: 5))
		guard folderToggle(1).isHittable == false else { throw XCTSkip("Requires compact navigation") }
		let pane = app.descendants(matching: .any)["collection-pane-feed/navigation-1-1"].firstMatch
		let start = pane.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
		start.press(forDuration: 0.1, thenDragTo: pane.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5)),
			withVelocity: .slow, thenHoldForDuration: 0.5)
		XCTAssertTrue(app.navigationBars["Feed 01.01"].exists)
		XCTAssertTrue(app.staticTexts["Designing calmer tools for people who read every day"].exists)
	}

	func testDensityChangeKeepsTheVisibleStoryInsteadOfReturningToTheTop() throws {
		let story = try openScrolledStressFeed()
		app.buttons["article-list-more"].tap()
		app.buttons["article-list-density"].tap()
		app.buttons["Compact"].tap()
		let staysVisible = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: story)
		XCTAssertEqual(XCTWaiter.wait(for: [staysVisible], timeout: 5), .completed)
		XCTAssertGreaterThanOrEqual(story.frame.minY, app.navigationBars["Feed 01.01"].frame.maxY - 1)
		XCTAssertFalse(app.staticTexts["Motion story 1"].isHittable)
	}

	func testUnreadFilterKeepsANearbySurvivingStoryVisible() throws {
		let story = try openScrolledStressFeed()
		app.buttons["article-list-filter"].tap()
		app.buttons["Unread"].tap()
		let staysVisible = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: story)
		XCTAssertEqual(XCTWaiter.wait(for: [staysVisible], timeout: 5), .completed)
		XCTAssertFalse(app.staticTexts["Motion story 1"].isHittable)
	}

	func testRotationKeepsTheVisibleStoryAndRestoresItsPortraitPosition() throws {
		XCUIDevice.shared.orientation = .portrait
		defer { XCUIDevice.shared.orientation = .portrait }
		let story = try openScrolledStressFeed()
		let portraitY = story.frame.minY
		XCUIDevice.shared.orientation = .landscapeLeft
		let visible = NSPredicate(format: "hittable == true")
		XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: visible, object: story)], timeout: 5), .completed)
		XCTAssertFalse(app.staticTexts["Motion story 1"].isHittable)
		let landscape = XCTAttachment(screenshot: app.screenshot())
		landscape.name = "Feed after landscape rotation"
		landscape.lifetime = .keepAlways
		add(landscape)
		XCUIDevice.shared.orientation = .portrait
		XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: visible, object: story)], timeout: 5), .completed)
		XCTAssertEqual(story.frame.minY, portraitY, accuracy: 20)
	}

	func testSearchCanBeRefinedAndClearedWithoutLeavingTheFeed() {
		folderToggle(1).tap()
		feed(1, 1).tap()
		let pane = app.descendants(matching: .any)["collection-pane-feed/navigation-1-1"].firstMatch
		XCTAssertTrue(pane.waitForExistence(timeout: 5))
		// Persist the preview stories through the same refresh path as a real feed.
		pane.swipeDown()
		let field = app.searchFields.firstMatch
		XCTAssertTrue(field.waitForExistence(timeout: 5))
		field.tap()
		field.typeText("Designing")
		let story = app.staticTexts["Designing calmer tools for people who read every day"]
		XCTAssertTrue(story.waitForExistence(timeout: 5))
		XCTAssertFalse(app.descendants(matching: .any)["article-search-empty"].exists)
		field.typeText(" qzxmissing")
		XCTAssertTrue(app.descendants(matching: .any)["article-search-empty"].waitForExistence(timeout: 5))
		field.buttons["Clear text"].tap()
		XCTAssertTrue(story.waitForExistence(timeout: 5))
		XCTAssertTrue(app.navigationBars["Feed 01.01"].exists)
	}

	private func openScrolledStressFeed() throws -> XCUIElement {
		launchFixture(additionalArguments: ["-reader-motion-stress-fixture"])
		folderToggle(1).tap()
		feed(1, 1).tap()
		let pane = app.descendants(matching: .any)["collection-pane-feed/navigation-1-1"].firstMatch
		XCTAssertTrue(app.staticTexts["Motion story 1"].waitForExistence(timeout: 5))
		pane.swipeUp()
		pane.swipeUp()
		let stories = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Motion story "))
		let visibleTop = max(pane.frame.minY, app.navigationBars["Feed 01.01"].frame.maxY)
		let surviving = stories.allElementsBoundByIndex.compactMap { element -> XCUIElement? in
			let label = element.label
			guard let number = Int(label.replacingOccurrences(of: "Motion story ", with: "")),
				number > 1, number.isMultiple(of: 3) == false else { return nil }
			// Resolve stable identity before checking visibility. UIKit can report
			// a clipped title beneath the translucent bar as hittable; require its
			// entire title to be inside the visible feed before testing continuity.
			let story = app.staticTexts[label].firstMatch
			guard story.isHittable, story.frame.minY >= visibleTop,
				story.frame.maxY <= pane.frame.maxY else { return nil }
			return story
		}.sorted { $0.frame.minY < $1.frame.minY }
		return try XCTUnwrap(surviving.first)
	}

	private func launchFixture(additionalArguments: [String] = []) {
		app.terminate()
		app.launchArguments = ["-reader-sample-data", "-reader-show-sidebar", "-reader-reset-reader-state", "-reader-navigation-fixture"] + additionalArguments
		app.launch()
		if folderToggle(1).waitForExistence(timeout: 2) {
			return
		}

		// Current startup can restore the fixture's For You feed as a compact
		// detail push even when the sidebar argument is present. Pop that native
		// destination before beginning the sidebar motion assertions.
		let backCandidates = [
			app.navigationBars.buttons["Back"].firstMatch,
			app.buttons["Back"].firstMatch,
			app.buttons["BackButton"].firstMatch,
		]
		for back in backCandidates where back.waitForExistence(timeout: 2) && back.isHittable {
			back.tap()
			break
		}
		XCTAssertTrue(folderToggle(1).waitForExistence(timeout: 10))
	}

	private func folderToggle(_ number: Int) -> XCUIElement {
		app.buttons["reader-sidebar-folder-toggle-navigation-folder-\(number)"]
	}

	private func feed(_ folder: Int, _ number: Int) -> XCUIElement {
		app.descendants(matching: .any)["reader-sidebar-item-feed/navigation-\(folder)-\(number)"].firstMatch
	}
}
