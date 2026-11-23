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
		// A single feed's days, Today included, are all day cards.
		#expect(FeedDaySections.make(
			articles: [
				story("feed-today", feed: "feed/1", at: todayStart.addingTimeInterval(60)),
				story("day", feed: "feed/1", at: todayStart.addingTimeInterval(-3_600)),
			], now: now,
		).readingLogRows == ["feed-today": "card-day", "day": "card-day"])
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

	/// Above and below follow the cards as drawn: each story at its first
	/// appearance, and nothing hidden behind "N more".
	@Test func markAboveAndBelowFollowTheCardOrder() async throws {
		let (model, folder, sections) = try cardsFixture()
		// Today a1 b1, Last 7 Days a2 b2, Alpha a1 a2 a3 (a4 a5 behind "2 more"), Beta b1 b2 b3.
		#expect(sections.renderedArticles.map(\.id) == ["a1", "b1", "a2", "b2", "a3", "b3"])
		let b3 = try #require(model.allArticles(for: folder).first { $0.id == "b3" })

		await model.markStoriesBelowAsRead(b3, in: folder, order: sections.renderedArticles)
		#expect(model.allArticles(for: folder).filter(\.isRead).isEmpty)

		await model.markStoriesAboveAsRead(b3, in: folder, order: sections.renderedArticles)
		#expect(Set(model.allArticles(for: folder).filter(\.isRead).map(\.id)) == ["a1", "b1", "a2", "b2", "a3"])
	}

	/// Mark Above and Below slice the cards at the copy the menu was opened
	/// on: a story shown in Today and again in its feed's card has different
	/// neighbours in each place.
	@Test func markAboveAndBelowStartFromTheCopyTheMenuWasOpenedOn() async throws {
		let (model, folder, sections) = try cardsFixture()
		// Copies: Today a1 b1 | Last 7 Days a2 b2 | Alpha a1 a2 a3 | Beta b1 b2 b3.
		#expect(sections.renderedCopies.map(\.id) == ["a1", "b1", "a2", "b2", "a1", "a2", "a3", "b1", "b2", "b3"])
		let betaB1 = try #require(sections.copyIndex(of: 0, inSection: "feed:feed/8"))
		#expect(betaB1 == 7)
		let b1 = try #require(model.allArticles(for: folder).first { $0.id == "b1" })

		await model.markStoriesBelowAsRead(b1, in: folder, order: sections.renderedCopies, at: betaB1)
		#expect(Set(model.allArticles(for: folder).filter(\.isRead).map(\.id)) == ["b2", "b3"])
		await model.undoLastBulkRead()

		// Above Alpha's copy of a1: Today's b1 and Last 7 Days, not a1 itself.
		let alphaA1 = try #require(sections.copyIndex(of: 0, inSection: "feed:feed/7"))
		let a1 = try #require(model.allArticles(for: folder).first { $0.id == "a1" })
		await model.markStoriesAboveAsRead(a1, in: folder, order: sections.renderedCopies, at: alphaA1)
		#expect(Set(model.allArticles(for: folder).filter(\.isRead).map(\.id)) == ["b1", "a2", "b2"])
	}

	/// Next and previous in the reader follow the cards as drawn (each story at
	/// its first appearance), not the folder's saved sort.
	@Test func nextAndPreviousFollowTheCardOrder() throws {
		let (model, folder, sections) = try cardsFixture()
		model.setSortOrder(.oldest, for: folder)
		#expect(model.articles(for: folder).first?.id == "a5")
		let order = sections.uniqueArticleIDs
		#expect(order == ["a1", "b1", "a2", "b2", "a3", "b3"])

		model.retainPresentedArticles(model.articles(for: folder), in: folder, order: order)
		let b1 = try #require(model.allArticles(for: folder).first { $0.id == "b1" })
		model.select(article: b1)
		#expect(model.articleTarget(for: .next, from: b1)?.id == "a2")
		#expect(model.articleTarget(for: .previous, from: b1)?.id == "a1")
		let b3 = try #require(model.allArticles(for: folder).first { $0.id == "b3" })
		// Stories no card draws come after the drawn ones, in the list's order.
		#expect(model.articleTarget(for: .next, from: b3)?.id == "a5")

		// A list without a drawn order (Reeder) goes back to the saved sort,
		// oldest first.
		model.retainPresentedArticles(model.articles(for: folder), in: folder, order: nil)
		#expect(model.articleTarget(for: .next, from: b1)?.id == "a1")
		#expect(model.articleTarget(for: .previous, from: b1)?.id == "a2")
	}

	@Test func aFeedOpenedFromAFolderCardIsPushedAboveTheFolder() throws {
		let navigation = Self.navigation()
		let model = try makeModel()
		model.setNavigation(navigation)
		let folder = try #require(navigation.item(withID: Self.tech))
		let feed = try #require(navigation.item(withID: "feed/7::\(Self.tech)"))
		model.select(item: folder)

		model.openFeed(feed, fromFolder: folder)
		#expect(model.selectedNavigationID == feed.id)
		#expect(model.cardFeedPath == [ReaderCardFeedDestination(feedID: feed.id)])
		// The folder stays the column's root, under the pushed feed.
		#expect(model.contentRootCollection.id == folder.id)

		// The system back button or the edge swipe pops the path.
		model.cardFeedPath = []
		#expect(model.selectedNavigationID == folder.id)
		#expect(model.preferredCompactColumn == .content)
		#expect(model.contentRootCollection.id == folder.id)
	}

	/// Cards is one stack above Home: the list, then a feed above its folder.
	@Test func theCardsStackFollowsHomeTheListAndAPushedFeed() throws {
		let navigation = Self.navigation()
		let model = try makeModel()
		model.setNavigation(navigation)
		let folder = try #require(navigation.item(withID: Self.tech))
		let feed = try #require(navigation.item(withID: "feed/7::\(Self.tech)"))
		model.preferredCompactColumn = .sidebar
		#expect(model.cardsPath.isEmpty)

		model.select(item: folder)
		#expect(model.cardsPath == [.list])
		model.openFeed(feed, fromFolder: folder)
		#expect(model.cardsPath == [.list, .feed(feed.id)])

		// A story open over the feed keeps the stack under it.
		model.preferredCompactColumn = .detail
		#expect(model.cardsPath == [.list, .feed(feed.id)])
		model.preferredCompactColumn = .content

		// Back from the feed is the folder; back from the folder is Home.
		model.cardsPath = [.list]
		#expect(model.selectedNavigationID == folder.id)
		#expect(model.contentRootCollection.id == folder.id)
		model.cardsPath = []
		#expect(model.preferredCompactColumn == .sidebar)
		#expect(model.selectedNavigationID == folder.id)
	}

	@Test func choosingAnotherListOrGoingHomeClearsThePushedFeed() throws {
		let navigation = Self.navigation()
		let model = try makeModel()
		model.setNavigation(navigation)
		let folder = try #require(navigation.item(withID: Self.tech))
		let feed = try #require(navigation.item(withID: "feed/7::\(Self.tech)"))
		let other = try #require(navigation.item(withID: "feed/9"))
		model.select(item: folder)

		model.openFeed(feed, fromFolder: folder)
		model.select(item: other)
		#expect(model.cardFeedPath.isEmpty)
		#expect(model.contentRootCollection.id == other.id)

		// Going Home leaves the stack for the swipe that may come back to it;
		// choosing a list from Home starts a new one.
		model.select(item: folder)
		model.openFeed(feed, fromFolder: folder)
		model.cardsPath = []
		model.select(item: folder)
		#expect(model.cardFeedPath.isEmpty)
		#expect(model.contentRootCollection.id == folder.id)

		// A feed opened from Home or the library is the root itself.
		model.select(item: feed)
		#expect(model.cardFeedPath.isEmpty)
		#expect(model.contentRootCollection.id == feed.id)
	}

	/// The Cards page re-renders at local midnight: the model's day moves on
	/// when the day changes, and the page's sections are keyed by it.
	@Test func theLocalDayMovesOnAtMidnight() async throws {
		let model = try makeModel()
		let today = ReaderLocalDayBounds.localDay(containing: .now)
		#expect(model.localDayStart == today.start)

		await model.handleLocalDayChange(now: today.end.addingTimeInterval(60))
		#expect(model.localDayStart == today.end)
	}

	/// The page's sections are built once per change of what they show, not on
	/// every body pass.
	@Test func cardSectionsAreBuiltOncePerChange() throws {
		let cache = FolderCardsSectionsCache()
		let todayStart = ReaderLocalDayBounds.localDay(containing: Date()).start
		let articles = [story("a", feed: "feed/1", at: todayStart.addingTimeInterval(60))]
		var builds = 0
		func sections(_ articles: [Recommendation], expanded: Set<String> = [], day: Date = todayStart) -> FolderSections {
			cache.sections(for: .init(articles: articles, expanded: expanded, feeds: .empty, isFolder: true, collapsesDays: true, day: day)) {
				builds += 1
				return FolderSections.make(articles: articles, feeds: .empty, now: day.addingTimeInterval(60))
			}
		}

		_ = sections(articles)
		_ = sections(articles)
		#expect(builds == 1)
		var read = articles
		read[0].isRead = true
		#expect(sections(read).sections.first?.articles.first?.isRead == true)
		_ = sections(read, expanded: ["today"])
		_ = sections(read, expanded: ["today"], day: todayStart.addingTimeInterval(86_400))
		#expect(builds == 4)
	}

	// MARK: Helpers

	/// Tech holds Alpha (a1 to a5) and Beta (b1 to b3), drawn at noon UTC.
	private func cardsFixture() throws -> (ReaderAppModel, ReaderNavigationItem, FolderSections) {
		let model = try makeModel()
		let navigation = Self.navigation()
		model.setNavigation(navigation)
		let folder = try #require(navigation.item(withID: Self.tech))
		model.select(item: folder)
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
		let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 20, hour: 12)))
		func ago(_ days: Double) -> Date { now.addingTimeInterval(-days * 86_400) }
		model.setArticles([
			story("a1", feed: "feed/7", at: ago(0.05)), story("b1", feed: "feed/8", at: ago(0.1)),
			story("a2", feed: "feed/7", at: ago(2)), story("b2", feed: "feed/8", at: ago(3)),
			story("b3", feed: "feed/8", at: ago(9)),
			story("a3", feed: "feed/7", at: ago(10)), story("a4", feed: "feed/7", at: ago(11)),
			story("a5", feed: "feed/7", at: ago(12)),
		], for: folder)
		let sections = FolderSections.make(
			articles: model.articles(for: folder), feeds: model.articleFeedDirectory, now: now, calendar: calendar, expanded: [],
		)
		return (model, folder, sections)
	}

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
		let typography = ReaderTypographySettings(defaults: defaults)
		typography.look = .cards
		return ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: MockHTTPClient(shouldFail: true),
			articleFilterStore: ReaderArticleFilterStore(defaults: defaults),
			offlineStore: OfflineLibraryStore.inMemory(),
			offlineSynchronizationEnabled: false,
			readerTypography: typography,
		)
	}
}
