import Foundation
import Testing
@testable import PigeonReader

/// The glue between `FolderSections` and the Cards look: colours, columns,
/// reading-log rows, duplicated stories and card order for bulk reads.
@MainActor
struct FolderCardsTests {
	private static let design = "user/-/label/Design"
	private static let news = "user/-/label/News"
	private static let tech = "user/-/label/Tech"

	@Test func folderColorMatchesHomeTile() throws {
		let navigation = Self.navigation()
		let model = try makeModel()
		model.setNavigation(navigation)
		let snapshot = ReaderSidebarPresentationSnapshot.make(
			accountID: "account", selectedNavigationID: ReaderSection.forYou.rawValue, sidebarFilter: .all,
			enabledSmartViewSections: [.forYou], navigation: navigation,
		)
		let tiles = ReaderHomeTiles.make(snapshot: snapshot, navigation: navigation) { _ in nil }

		#expect(tiles.folders.count == 3)
		for tile in tiles.folders {
			#expect(model.cardColorIndex(for: tile.item) == tile.colorIndex)
		}
		// A feed opened from its folder keeps the folder's colour.
		let techTile = try #require(tiles.folders.first { $0.id == Self.tech })
		let techFeed = try #require(navigation.item(withID: "feed/7::\(Self.tech)"))
		#expect(model.cardColorIndex(for: techFeed) == techTile.colorIndex)
		// A feed in no folder has its own kicker colour, as on the Front Page.
		let unfiled = try #require(navigation.item(withID: "feed/9"))
		#expect(model.cardColorIndex(for: unfiled) == FrontPageKickerPalette.colorIndex(for: "feed/9"))
	}

	@Test func feedCardsGoOneColumnOnAPhoneAndUpToThreeWhenWide() {
		#expect(FolderCardsLayout.feedColumnCount(usesAccessibilitySize: false, availableWidth: nil) == 1)
		#expect(FolderCardsLayout.feedColumnCount(usesAccessibilitySize: false, availableWidth: 402) == 1)
		#expect(FolderCardsLayout.feedColumnCount(usesAccessibilitySize: false, availableWidth: 620) == 2)
		// iPad mini and iPad Pro 11-inch in portrait, and landscape.
		#expect(FolderCardsLayout.feedColumnCount(usesAccessibilitySize: false, availableWidth: 744) == 3)
		#expect(FolderCardsLayout.feedColumnCount(usesAccessibilitySize: false, availableWidth: 834) == 3)
		#expect(FolderCardsLayout.feedColumnCount(usesAccessibilitySize: false, availableWidth: 1_210) == 3)
		// Accessibility sizes are one column of cards at every width.
		#expect(FolderCardsLayout.feedColumnCount(usesAccessibilitySize: true, availableWidth: 1_210) == 1)
	}

	/// Feed cards are laid out eagerly in rows: a lazy grid inside the lazy
	/// page kept re-estimating the page's height, which flipped the near-end
	/// flag on every layout pass and hung the app on an iPad.
	@Test func feedCardRowsFillLeftToRightAndKeepTheLastRowShort() {
		let ids = ["a", "b", "c", "d", "e"]

		#expect(FolderCardsLayout.rows(of: ids, columns: 3) == [["a", "b", "c"], ["d", "e"]])
		#expect(FolderCardsLayout.rows(of: ids, columns: 1) == ids.map { [$0] })
		#expect(FolderCardsLayout.rows(of: [String](), columns: 3).isEmpty)
		// A zero column count from a bad width still lays every card out.
		#expect(FolderCardsLayout.rows(of: ids, columns: 0) == ids.map { [$0] })
	}

	@Test func readingLogRowsNameTheCardThatShowsAStoryFirst() {
		let todayStart = ReaderLocalDayBounds.localDay(containing: Date()).start
		let now = todayStart.addingTimeInterval(43_200)
		let sections = FolderSections.make(
			articles: [
				story("today", feed: "feed/1", at: todayStart.addingTimeInterval(60)),
				story("week", feed: "feed/1", at: todayStart.addingTimeInterval(-3_600)),
				story("old", feed: "feed/2", at: todayStart.addingTimeInterval(-30 * 86_400)),
			],
			feeds: .empty, now: now,
		)

		#expect(sections.readingLogRows == ["today": "card-today", "week": "card-last-7-days", "old": "card-feed"])
		#expect(FeedDaySections.make(
			articles: [story("day", feed: "feed/1", at: todayStart.addingTimeInterval(-3_600))], now: now,
		).readingLogRows == ["day": "card-day"])
	}

	@Test func aStoryShownTwiceIsVisibleWhileEitherCopyIs() {
		var copies = ReaderVisibleRowCopies()

		#expect(copies.set("a", copy: "today", visible: true) == true)
		#expect(copies.set("a", copy: "feed:feed/1", visible: true) == nil)
		#expect(copies.set("a", copy: "today", visible: false) == nil)
		#expect(copies.set("a", copy: "feed:feed/1", visible: false) == false)
		#expect(copies.set("a", copy: "today", visible: false) == nil)
		#expect(copies.set("b", copy: "today", visible: true) == true)
	}

	@Test func markAboveInCardsFollowsNewestFirstNotTheFolderSort() async throws {
		let model = try makeModel()
		let navigation = Self.navigation()
		model.setNavigation(navigation)
		let folder = try #require(navigation.item(withID: Self.tech))
		model.select(item: folder)
		let base = Date(timeIntervalSince1970: 1_800_000_000)
		let stories = [
			story("alpha-new", feed: "feed/7", at: base.addingTimeInterval(4)),
			story("alpha-old", feed: "feed/7", at: base.addingTimeInterval(1)),
			story("beta-new", feed: "feed/8", at: base.addingTimeInterval(9)),
			story("beta-old", feed: "feed/8", at: base.addingTimeInterval(5)),
		]
		model.setArticles(stories, for: folder)
		#expect(model.sortOrder(for: folder) == .byFeed)
		let betaOld = try #require(model.allArticles(for: folder).first { $0.id == "beta-old" })

		await model.markStoriesAboveAsRead(betaOld, in: folder, order: FolderSections.newestFirst(model.articles(for: folder)))

		#expect(model.allArticles(for: folder).filter(\.isRead).map(\.id) == ["beta-new"])
	}

	@Test func backFromAFeedOpenedFromAFolderCardReturnsToTheFolder() throws {
		let navigation = Self.navigation()
		let model = try makeModel()
		model.setNavigation(navigation)
		let folder = try #require(navigation.item(withID: Self.tech))
		let feed = try #require(navigation.item(withID: "feed/7::\(Self.tech)"))
		model.select(item: folder)

		model.openFeed(feed, fromFolder: folder)
		#expect(model.selectedNavigationID == feed.id)
		#expect(model.folderToReturnTo?.id == folder.id)

		model.returnToFolder()
		#expect(model.selectedNavigationID == folder.id)
		#expect(model.preferredCompactColumn == .content)
		#expect(model.folderToReturnTo == nil)
	}

	@Test func choosingAnotherListOrGoingHomeForgetsTheFolder() throws {
		let navigation = Self.navigation()
		let model = try makeModel()
		model.setNavigation(navigation)
		let folder = try #require(navigation.item(withID: Self.tech))
		let feed = try #require(navigation.item(withID: "feed/7::\(Self.tech)"))
		let other = try #require(navigation.item(withID: "feed/9"))
		model.select(item: folder)

		model.openFeed(feed, fromFolder: folder)
		model.select(item: other)
		#expect(model.folderToReturnTo == nil)

		model.select(item: folder)
		model.openFeed(feed, fromFolder: folder)
		model.showHome()
		#expect(model.folderToReturnTo == nil)

		// A feed opened from Home or the library has no folder to return to.
		model.select(item: feed)
		#expect(model.folderToReturnTo == nil)
	}

	// MARK: Helpers

	private static func navigation() -> ReaderNavigationState {
		ReaderNavigationState(items: [
			.smart(.forYou),
			folder(design), folder(news), folder(tech),
			feed("feed/7", title: "Alpha", parent: tech),
			feed("feed/8", title: "Beta", parent: tech),
			feed("feed/9", title: "Loose", parent: nil),
		])
	}

	private static func folder(_ id: String) -> ReaderNavigationItem {
		ReaderNavigationItem(
			id: id, title: String(id.split(separator: "/").last ?? ""), streamID: id, kind: .folder, unreadCount: 1,
			parentID: nil, feedKey: nil, iconURL: nil, smartSection: nil,
		)
	}

	private static func feed(_ streamID: String, title: String, parent: String?) -> ReaderNavigationItem {
		ReaderNavigationItem(
			id: parent.map { "\(streamID)::\($0)" } ?? streamID, title: title, streamID: streamID, kind: .feed,
			unreadCount: 1, parentID: parent, feedKey: nil, iconURL: nil, smartSection: nil,
		)
	}

	private func story(_ id: String, feed: String, at date: Date) -> Recommendation {
		Recommendation(
			id: id, readerId: id, feedKey: feed, source: feed, title: id, html: "<p>Story</p>", text: nil,
			originalURL: nil, receivedAt: date, isRead: false, isStarred: false,
			score: 0, confidence: 0, sampleCount: 0, explanation: "", learningState: "",
		)
	}

	private func makeModel() throws -> ReaderAppModel {
		let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "cards")
		let defaults = try #require(UserDefaults(suiteName: "pigeon-folder-cards-\(UUID().uuidString)"))
		return ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: MockHTTPClient(shouldFail: true),
			articleFilterStore: ReaderArticleFilterStore(defaults: defaults),
			offlineStore: OfflineLibraryStore.inMemory(),
			offlineSynchronizationEnabled: false,
		)
	}
}
