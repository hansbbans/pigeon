import XCTest

/// Walks the main screens on the device the suite runs on, in portrait and in
/// landscape, and records where every control landed.
///
/// `.github/workflows/ios-device-layout.yml` runs this class on an iPhone Pro,
/// an iPad Pro 11-inch and an iPad mini. Each screen produces a screenshot and
/// a text dump of element frames; `PIGEON-LAYOUT-SUMMARY` and
/// `PIGEON-LAYOUT-FINDING` lines also go to the test log, so a layout can be
/// reviewed from the log alone. Findings are observations (a control cut off
/// by the window edge, a small tap target, bar buttons on top of each other)
/// and do not fail the test. Only a screen that is missing fails it.
@MainActor
final class PigeonDeviceLayoutUITests: XCTestCase {
	private var app: XCUIApplication!

	override func setUp() async throws {
		continueAfterFailure = true
		app = XCUIApplication()
		app.launchArguments = [
			"-reader-sample-data",
			"-reader-show-sidebar",
			"-reader-reset-reader-state",
			"-reader-folder-read-data",
		]
	}

	override func tearDown() async throws {
		XCUIDevice.shared.orientation = .portrait
	}

	func testPortraitLayout() {
		walk(orientation: .portrait, name: "portrait")
	}

	func testLandscapeLayout() {
		walk(orientation: .landscapeLeft, name: "landscape")
	}

	private func walk(orientation: UIDeviceOrientation, name: String) {
		XCUIDevice.shared.orientation = orientation
		app.launchWithoutAnimations()
		let recorder = PigeonLayoutRecorder(app: app, orientation: name, testCase: self)
		let isPad = UIDevice.current.userInterfaceIdiom == .pad

		// Home: the tile grid at every width.
		let tiles = element("reader-home-tiles")
		recorder.expect(tiles.waitForExistence(timeout: 20), "Home shows the tile grid")
		let folderColumns = columnCount(of: app.buttons.matching(
			NSPredicate(format: "identifier BEGINSWITH %@", "reader-sidebar-item-user/"),
		))
		recorder.note("folder-tile-columns", "\(folderColumns)")
		if isPad {
			recorder.expect(folderColumns >= 3, "An iPad shows at least three folder tiles across")
		}
		recorder.capture("home")

		// The full library list, one tap from Home.
		let allFeeds = app.buttons["reader-home-all-feeds"]
		for _ in 0..<4 where allFeeds.exists && allFeeds.isHittable == false {
			app.swipeUp()
		}
		if allFeeds.exists, allFeeds.isHittable {
			allFeeds.tap()
			recorder.expect(element("reader-sidebar").waitForExistence(timeout: 10), "All Feeds shows the library list")
			recorder.capture("library")
			let showTiles = app.buttons["reader-home-show-tiles"]
			if showTiles.waitForExistence(timeout: 5) {
				showTiles.tap()
			}
			recorder.expect(tiles.waitForExistence(timeout: 10), "Home returns from the library list")
		} else {
			recorder.expect(false, "All Feeds is reachable on Home")
		}

		// A story list in Classic rows.
		let forYou = app.buttons["reader-sidebar-item-forYou"]
		for _ in 0..<4 where forYou.exists && forYou.isHittable == false {
			app.swipeDown()
		}
		recorder.expect(forYou.waitForExistence(timeout: 10), "Home offers For You")
		forYou.tap()
		let firstStory = app.staticTexts["Designing calmer tools for people who read every day"]
		recorder.expect(firstStory.waitForExistence(timeout: 15), "For You lists its stories")
		let showHome = app.buttons["reader-show-home"]
		recorder.note("home-button", showHome.exists ? (showHome.isHittable ? "hittable" : "hidden") : "absent")
		if isPad {
			recorder.expect(showHome.exists && showHome.isHittable, "An iPad list offers a way back to Home")
		}
		recorder.capture("list-classic")

		// Settings, from the list's menu.
		let more = app.buttons["article-list-more"]
		if more.waitForExistence(timeout: 5), more.isHittable {
			more.tap()
			let settings = app.buttons["Settings"].firstMatch
			if settings.waitForExistence(timeout: 5) {
				settings.tap()
				recorder.expect(app.navigationBars["Settings"].waitForExistence(timeout: 10), "Settings opens")
				recorder.capture("settings")
				let done = app.navigationBars["Settings"].buttons["Done"]
				if done.exists {
					done.tap()
				}
				recorder.expect(app.navigationBars["Settings"].waitForNonExistence(timeout: 10), "Settings closes")
			} else {
				recorder.expect(false, "The list menu offers Settings")
			}
		} else {
			recorder.expect(false, "The list toolbar offers its menu")
		}

		// The same list as a Front Page.
		chooseFrontPage(recorder: recorder)
		let stories = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "front-page-story-"))
		recorder.expect(stories.firstMatch.waitForExistence(timeout: 10), "Front Page lays out its stories")
		recorder.note("front-page-columns", "\(columnCount(of: stories))")
		recorder.capture("list-front-page")

		// An open story.
		if stories.firstMatch.exists {
			stories.firstMatch.tap()
		}
		let reader = app.scrollViews["article-reader-scroll-view"]
		recorder.expect(reader.waitForExistence(timeout: 15), "A story opens in the reader")
		let controls = app.buttons["reader-reading-controls"]
		recorder.expect(controls.waitForExistence(timeout: 10) && controls.isHittable, "The reader offers its reading controls")
		recorder.capture("reader")

		// Home again from an open story, and back to the story's list.
		if showHome.exists, showHome.isHittable {
			showHome.tap()
			recorder.expect(tiles.waitForExistence(timeout: 10), "Home covers the split view again")
			recorder.expect(forYou.waitForExistence(timeout: 5) && forYou.isHittable, "Home is usable after returning to it")
			recorder.capture("home-returned")
			if forYou.exists, forYou.isHittable {
				forYou.tap()
			}
			recorder.expect(reader.waitForExistence(timeout: 10), "The open story is still there after Home")
		}

		// The other orientation, with the story open.
		XCUIDevice.shared.orientation = orientation == .portrait ? .landscapeLeft : .portrait
		recorder.expect(reader.waitForExistence(timeout: 10), "The reader survives rotation")
		recorder.capture("reader-rotated")
		XCUIDevice.shared.orientation = orientation
		recorder.expect(reader.waitForExistence(timeout: 10), "The reader survives rotating back")

		// Reading controls come last: how they are dismissed differs by device.
		if controls.waitForExistence(timeout: 5), controls.isHittable {
			controls.tap()
			recorder.expect(element("reader-reading-theme").waitForExistence(timeout: 10), "Reading controls open")
			recorder.capture("reading-controls")
		}

		recorder.finish()
	}

	private func chooseFrontPage(recorder: PigeonLayoutRecorder) {
		let more = app.buttons["article-list-more"]
		guard more.waitForExistence(timeout: 5), more.isHittable else {
			recorder.expect(false, "The list toolbar offers its menu")
			return
		}
		more.tap()
		let display = app.buttons["article-list-density"]
		guard display.waitForExistence(timeout: 5) else {
			recorder.expect(false, "The list menu offers Display")
			return
		}
		display.tap()
		let frontPage = app.buttons["Front Page"]
		guard frontPage.waitForExistence(timeout: 5) else {
			recorder.expect(false, "Display offers the Front Page layout")
			return
		}
		frontPage.tap()
	}

	private func element(_ identifier: String) -> XCUIElement {
		app.descendants(matching: .any)[identifier].firstMatch
	}

	/// Distinct left edges among the visible elements of a query.
	private func columnCount(of query: XCUIElementQuery) -> Int {
		let window = app.frame
		var edges: [CGFloat] = []
		for element in query.allElementsBoundByIndex where element.exists {
			let frame = element.frame
			guard frame.intersects(window), frame.width > 1 else { continue }
			if edges.contains(where: { abs($0 - frame.minX) < 4 }) == false {
				edges.append(frame.minX)
			}
		}
		return edges.count
	}
}

/// Records one screen at a time: a screenshot, a dump of element frames, and a
/// short list of things that look wrong.
@MainActor
private final class PigeonLayoutRecorder {
	private struct Node {
		let type: XCUIElement.ElementType
		let identifier: String
		let label: String
		let frame: CGRect
		let bar: Int?
	}

	private let app: XCUIApplication
	private let orientation: String
	private let testCase: XCTestCase
	private let device: String
	private let outputDirectory: URL?
	private var screenIndex = 0
	private var notes: [String] = []
	private var failedExpectations: [String] = []

	init(app: XCUIApplication, orientation: String, testCase: XCTestCase) {
		self.app = app
		self.orientation = orientation
		self.testCase = testCase
		let environment = ProcessInfo.processInfo.environment
		device = environment["PIGEON_LAYOUT_DEVICE"] ?? UIDevice.current.name
		outputDirectory = environment["PIGEON_LAYOUT_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
	}

	/// A fact about the next captured screen, such as a column count.
	func note(_ name: String, _ value: String) {
		notes.append("\(name)=\(value)")
	}

	/// A screen or control the walk depends on. Recorded now, failed at the end,
	/// so one missing screen does not hide the rest.
	func expect(_ condition: Bool, _ description: String) {
		guard condition == false else { return }
		failedExpectations.append(description)
		emit("PIGEON-LAYOUT-FINDING|\(device)|\(orientation)|-|expectation-failed|\(description)")
	}

	func capture(_ screen: String) {
		screenIndex += 1
		let name = "\(sanitized(device))__\(orientation)__\(String(format: "%02d", screenIndex))-\(screen)"
		let screenshot = XCUIScreen.main.screenshot()
		let image = XCTAttachment(screenshot: screenshot)
		image.name = name
		image.lifetime = .keepAlways
		testCase.add(image)
		write(screenshot.pngRepresentation, to: "\(name).png")

		guard let snapshot = try? app.snapshot() else {
			emit("PIGEON-LAYOUT-FINDING|\(device)|\(orientation)|\(screen)|snapshot-failed|")
			notes.removeAll()
			return
		}
		let window = snapshot.frame
		var nodes: [Node] = []
		var barCount = 0
		func visit(_ element: any XCUIElementSnapshot, bar: Int?) {
			var bar = bar
			if Self.barTypes.contains(element.elementType) {
				bar = barCount
				barCount += 1
			}
			if element.identifier.isEmpty == false || Self.recordedTypes.contains(element.elementType) {
				nodes.append(Node(
					type: element.elementType,
					identifier: element.identifier,
					label: element.label,
					frame: element.frame,
					bar: bar,
				))
			}
			for child in element.children {
				visit(child, bar: bar)
			}
		}
		visit(snapshot, bar: nil)

		let visible = nodes.filter { $0.frame.width > 0 && $0.frame.height > 0 && $0.frame.intersects(window) }
		var findings: [String] = []
		for node in visible where Self.clippedTypes.contains(node.type) {
			if node.frame.minX < window.minX - 1 || node.frame.maxX > window.maxX + 1 {
				findings.append("cut-off-horizontally|\(describe(node))")
			}
		}
		for node in visible where node.type == .button && node.bar != nil {
			if min(node.frame.width, node.frame.height) < 30 {
				findings.append("small-bar-button|\(describe(node))")
			}
		}
		let barButtons = visible.filter { $0.type == .button && $0.bar != nil }
		for (index, first) in barButtons.enumerated() {
			for second in barButtons[(index + 1)...] where second.bar == first.bar {
				let overlap = first.frame.intersection(second.frame)
				guard overlap.isNull == false, overlap.width > 2, overlap.height > 2 else { continue }
				// A button drawn inside another is a container and its content.
				if first.frame.contains(second.frame) || second.frame.contains(first.frame) { continue }
				findings.append("bar-buttons-overlap|\(describe(first))|\(describe(second))")
			}
		}

		let bars = visible.filter { $0.type == .navigationBar || $0.type == .toolbar }
			.map { "\($0.identifier.isEmpty ? $0.label : $0.identifier)@\(format($0.frame))" }
		var seenPanes = Set<String>()
		let panes = visible.filter { node in
			Self.paneIdentifiers.contains(node.identifier) || node.identifier.hasPrefix("collection-pane-")
		}.filter { seenPanes.insert($0.identifier).inserted }
			.map { "\($0.identifier)@\(format($0.frame))" }
		let summary = [
			"PIGEON-LAYOUT-SUMMARY", device, orientation, screen,
			"window=\(format(window))",
			"bars=\(bars.joined(separator: ";"))",
			"panes=\(panes.joined(separator: ";"))",
			"notes=\(notes.joined(separator: ";"))",
			"nodes=\(visible.count)",
			"findings=\(findings.count)",
		].joined(separator: "|")
		notes.removeAll()

		var lines = [summary]
		lines += findings.map { "PIGEON-LAYOUT-FINDING|\(device)|\(orientation)|\(screen)|\($0)" }
		for line in lines {
			emit(line)
		}
		lines += visible.map { "PIGEON-LAYOUT-NODE|\(screen)|\(describe($0))" }
		let text = lines.joined(separator: "\n") + "\n"
		let dump = XCTAttachment(string: text)
		dump.name = "\(name).txt"
		dump.lifetime = .keepAlways
		testCase.add(dump)
		write(Data(text.utf8), to: "\(name).txt")
	}

	func finish() {
		emit("PIGEON-LAYOUT-SUMMARY|\(device)|\(orientation)|done|screens=\(screenIndex)|failed-expectations=\(failedExpectations.count)")
		if failedExpectations.isEmpty == false {
			XCTFail("Layout walk on \(device) (\(orientation)) missed: \(failedExpectations.joined(separator: "; "))")
		}
	}

	private static let barTypes: Set<XCUIElement.ElementType> = [.navigationBar, .toolbar, .tabBar]
	private static let clippedTypes: Set<XCUIElement.ElementType> = [
		.button, .staticText, .textField, .searchField, .slider, .switch, .segmentedControl,
	]
	private static let recordedTypes: Set<XCUIElement.ElementType> = [
		.button, .staticText, .navigationBar, .toolbar, .tabBar, .textField, .searchField,
		.slider, .switch, .segmentedControl, .scrollView, .collectionView, .table, .webView, .image,
	]
	private static let paneIdentifiers: Set<String> = [
		"reader-home-tiles", "reader-sidebar", "article-reader-scroll-view", "article-reader-controls",
	]

	private func emit(_ line: String) {
		print(line)
		if let outputDirectory {
			let log = outputDirectory.appendingPathComponent("layout-log.txt")
			let data = Data((line + "\n").utf8)
			if let handle = try? FileHandle(forWritingTo: log) {
				_ = try? handle.seekToEnd()
				try? handle.write(contentsOf: data)
				try? handle.close()
			} else {
				try? data.write(to: log)
			}
		}
	}

	private func write(_ data: Data, to fileName: String) {
		guard let outputDirectory else { return }
		try? data.write(to: outputDirectory.appendingPathComponent(fileName))
	}

	private func describe(_ node: Node) -> String {
		let label = node.label.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "|", with: "/")
		return "\(Self.typeName(node.type))|\(node.identifier)|\(String(label.prefix(48)))|\(format(node.frame))"
	}

	private func format(_ frame: CGRect) -> String {
		"\(Int(frame.minX.rounded())),\(Int(frame.minY.rounded())),\(Int(frame.width.rounded())),\(Int(frame.height.rounded()))"
	}

	private func sanitized(_ text: String) -> String {
		String(text.map { $0.isLetter || $0.isNumber ? $0 : "-" })
	}

	private static func typeName(_ type: XCUIElement.ElementType) -> String {
		switch type {
		case .button: "button"
		case .staticText: "text"
		case .navigationBar: "navigation-bar"
		case .toolbar: "toolbar"
		case .tabBar: "tab-bar"
		case .textField: "text-field"
		case .searchField: "search-field"
		case .slider: "slider"
		case .switch: "switch"
		case .segmentedControl: "segmented-control"
		case .scrollView: "scroll-view"
		case .collectionView: "collection-view"
		case .table: "table"
		case .webView: "web-view"
		case .image: "image"
		case .cell: "cell"
		default: "other-\(type.rawValue)"
		}
	}
}
