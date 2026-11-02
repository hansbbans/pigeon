import Foundation
import Testing
@testable import PigeonReader

/// A story read from an Unread (or Read) list stays in place, dimmed, until a
/// deliberate event re-filters the list.
@MainActor
struct ReaderStickyReadTests {
	private let feed = ReaderNavigationItem(
		id: "feed/7", title: "Daily", streamID: "feed/7", kind: .feed,
		unreadCount: 3, parentID: nil, feedKey: "daily", iconURL: nil, smartSection: nil,
	)
	private let otherFeed = ReaderNavigationItem(
		id: "feed/8", title: "Weekly", streamID: "feed/8", kind: .feed,
		unreadCount: 0, parentID: nil, feedKey: "weekly", iconURL: nil, smartSection: nil,
	)
	private let unread = ReaderNavigationItem.smart(.unread, unreadCount: 3)

	// MARK: Staying in place

	@Test func openedArticleStaysInTheUnreadSectionOnCompactLayout() async throws {
		let (model, stories) = try makeUnreadSectionModel()
		model.select(article: stories[1])

		await model.recordExplicitOpen(for: stories[1])

		#expect(model.articles(for: unread).map(\.id) == ["a", "b", "c"])
		#expect(model.articles(for: unread)[1].isRead)
		#expect(model.selectedArticleID == "b")
		#expect(model.selectedArticle?.isRead == true)
		#expect(model.preferredCompactColumn == .detail)

		model.setArticles([stories[0], stories[2]], for: unread)

		#expect(model.articles(for: unread).map(\.id) == ["a", "b", "c"])
		#expect(model.selectedArticleID == "b")
		#expect(model.preferredCompactColumn == .detail)
	}

	@Test func manuallyReadArticleStaysInTheUnreadSectionWithoutAnOpenReader() async throws {
		let (model, stories) = try makeUnreadSectionModel()
		model.preferredCompactColumn = .content

		await model.setRead(stories[1], read: true)

		#expect(model.articles(for: unread).map(\.id) == ["a", "b", "c"])
		#expect(model.articles(for: unread)[1].isRead)
	}

	@Test func readArticleStaysInAFeedWithTheUnreadFilter() async throws {
		let (model, stories) = try makeFeedModel(filter: .unread)

		await model.setRead(stories[1], read: true)

		#expect(model.articles(for: feed).map(\.id) == ["a", "b", "c"])
		#expect(model.articles(for: feed)[1].isRead)
	}

	@Test func unreadArticleStaysInAFeedWithTheReadFilter() async throws {
		let (model, stories) = try makeFeedModel(filter: .read, isRead: true)

		await model.setRead(stories[1], read: false)

		#expect(model.articles(for: feed).map(\.id) == ["a", "b", "c"])
		#expect(model.articles(for: feed)[1].isRead == false)
	}

	@Test func readArticleSurvivesASyncThatOmitsIt() async throws {
		let (model, stories) = try makeUnreadSectionModel()
		await model.setRead(stories[1], read: true)

		model.setArticles([stories[0], stories[2]], for: unread)

		#expect(model.articles(for: unread).map(\.id) == ["a", "b", "c"])
		#expect(model.articles(for: unread)[1].isRead)
	}

	@Test func readArticleInAFeedSurvivesASyncThatOmitsIt() async throws {
		let (model, stories) = try makeFeedModel(filter: .unread)
		await model.setRead(stories[1], read: true)
		await model.setStarred(stories[1], starred: true)

		model.setArticles([stories[0], stories[2]], for: feed)

		#expect(model.articles(for: feed).map(\.id) == ["a", "b", "c"])
		#expect(model.articles(for: feed)[1].isRead)
		#expect(model.articles(for: feed)[1].isStarred)
	}

	@Test func markingAKeptArticleUnreadAgainRestoresIt() async throws {
		let (model, stories) = try makeUnreadSectionModel()
		await model.setRead(stories[1], read: true)

		await model.setRead(stories[1], read: false)

		#expect(model.articles(for: unread).map(\.id) == ["a", "b", "c"])
		#expect(model.articles(for: unread).allSatisfy { $0.isRead == false })
	}

	@Test func nextAndPreviousKeepTheListOrderAfterReading() async throws {
		let (model, stories) = try makeUnreadSectionModel()
		model.select(article: stories[1])
		await model.recordExplicitOpen(for: stories[1])

		#expect(model.navigateArticle(.next)?.id == "c")
		await model.recordExplicitOpen(for: stories[2])
		#expect(model.navigateArticle(.previous)?.id == "b")
		#expect(model.navigateArticle(.previous)?.id == "a")
		#expect(model.articles(for: unread).map(\.id) == ["a", "b", "c"])
	}

	@Test func feedNavigationKeepsTheListOrderAfterReading() async throws {
		let (model, stories) = try makeFeedModel(filter: .unread)
		model.select(article: stories[0])
		await model.recordExplicitOpen(for: stories[0])

		#expect(model.navigateArticle(.next)?.id == "b")
		await model.recordExplicitOpen(for: stories[1])
		#expect(model.navigateArticle(.previous)?.id == "a")
		#expect(model.navigateArticle(.next)?.id == "b")
		#expect(model.navigateArticle(.next)?.id == "c")
	}

	// MARK: Deliberate re-filtering

	@Test func switchingCollectionsClearsKeptArticles() async throws {
		let (model, stories) = try makeFeedModel(filter: .unread)
		await model.setRead(stories[1], read: true)

		model.select(item: otherFeed)
		model.select(item: feed)

		#expect(model.articles(for: feed).map(\.id) == ["a", "c"])
	}

	@Test func switchingAwayFromTheUnreadSectionClearsKeptArticles() async throws {
		let (model, stories) = try makeUnreadSectionModel()
		await model.setRead(stories[1], read: true)

		model.select(item: feed)
		model.select(item: unread)

		#expect(model.articles(for: unread).map(\.id) == ["a", "c"])
	}

	@Test func changingTheReadFilterClearsKeptArticles() async throws {
		let (model, stories) = try makeFeedModel(filter: .unread)
		await model.setRead(stories[1], read: true)

		model.setArticleFilter(.all, for: feed)
		#expect(model.articles(for: feed).map(\.id) == ["a", "b", "c"])
		model.setArticleFilter(.unread, for: feed)

		#expect(model.articles(for: feed).map(\.id) == ["a", "c"])
	}

	@Test func changingTheSortClearsKeptArticles() async throws {
		let (model, stories) = try makeFeedModel(filter: .unread)
		await model.setRead(stories[1], read: true)

		model.setSortOrder(.newest, for: feed)

		#expect(model.articles(for: feed).map(\.id) == ["c", "a"])
	}

	@Test func pullToRefreshClearsKeptArticles() async throws {
		let (model, stories) = try makeFeedModel(filter: .unread)
		await model.setRead(stories[1], read: true)

		await model.refresh(collection: feed)

		#expect(model.articles(for: feed).map(\.id) == ["a", "c"])
	}

	@Test func refreshingTheUnreadSectionClearsKeptArticles() async throws {
		let (model, stories) = try makeUnreadSectionModel()
		await model.setRead(stories[1], read: true)

		await model.refresh(collection: unread)

		#expect(model.articles(for: unread).map(\.id) == ["a", "c"])
	}

	@Test func markAllAsReadClearsKeptArticles() async throws {
		let (model, stories) = try makeFeedModel(filter: .unread)
		await model.setRead(stories[1], read: true)

		await model.markAllStoriesAsRead(in: feed)

		#expect(model.articles(for: feed).isEmpty)
	}

	@Test func markAboveAsReadClearsKeptArticles() async throws {
		let (model, stories) = try makeFeedModel(filter: .unread)
		await model.setRead(stories[2], read: true)

		await model.markStoriesAboveAsRead(stories[1], in: feed)

		#expect(model.articles(for: feed).map(\.id) == ["b"])
	}

	@Test func returningAfterALongBackgroundClearsKeptArticles() async throws {
		let (model, stories) = try makeFeedModel(filter: .unread)
		await model.setRead(stories[1], read: true)
		let start = Date.now

		model.handleScenePhase(.inactive, now: start)
		model.handleScenePhase(.active, now: start.addingTimeInterval(60))
		#expect(model.articles(for: feed).map(\.id) == ["a", "b", "c"])

		model.handleScenePhase(.inactive, now: start.addingTimeInterval(120))
		model.handleScenePhase(
			.active,
			now: start.addingTimeInterval(120 + ReaderAppModel.keptArticlesForegroundResetInterval),
		)
		#expect(model.articles(for: feed).map(\.id) == ["a", "c"])
	}

	// MARK: Review follow-ups

	@Test func refreshingWhileReadingAKeptStoryKeepsTheReaderOpen() async throws {
		let (model, stories) = try makeUnreadSectionModel(inFeedCache: false)
		model.select(article: stories[1])
		await model.recordExplicitOpen(for: stories[1])

		await model.refresh(collection: unread)

		#expect(model.articles(for: unread).map(\.id) == ["a", "c"])
		#expect(model.selectedArticle?.id == "b")
		#expect(model.selectedArticle?.isRead == true)
		#expect(model.preferredCompactColumn == .detail)
		#expect(model.navigateArticle(.next)?.id == "c")
	}

	@Test func markAllReadWhileReadingAKeptStoryKeepsTheReaderOpen() async throws {
		let (model, stories) = try makeUnreadSectionModel(inFeedCache: false)
		model.select(article: stories[1])
		await model.recordExplicitOpen(for: stories[1])

		await model.markAllStoriesAsRead(in: unread)

		#expect(model.articles(for: unread).isEmpty)
		#expect(model.selectedArticle?.id == "b")
		#expect(model.preferredCompactColumn == .detail)
	}

	@Test func changingTheFilterWhileReadingAKeptStoryOnRegularLayoutKeepsTheReader() async throws {
		let (model, stories) = try makeUnreadSectionModel(inFeedCache: false)
		model.select(article: stories[1])
		model.preferredCompactColumn = .content
		await model.setRead(stories[1], read: true)

		model.setArticleFilter(.all, for: unread)

		#expect(model.articles(for: unread).map(\.id) == ["a", "c"])
		#expect(model.selectedArticleID == "b")
		#expect(model.selectedArticle?.id == "b")
	}

	@Test func longBackgroundWhileReadingAKeptStoryKeepsTheReaderOpen() async throws {
		let (model, stories) = try makeUnreadSectionModel(inFeedCache: false)
		model.select(article: stories[1])
		await model.recordExplicitOpen(for: stories[1])
		let start = Date.now

		model.handleScenePhase(.inactive, now: start)
		model.handleScenePhase(.active, now: start.addingTimeInterval(ReaderAppModel.keptArticlesForegroundResetInterval))

		#expect(model.articles(for: unread).map(\.id) == ["a", "c"])
		#expect(model.selectedArticle?.id == "b")
	}

	@Test func tappingARowDoesNotWriteKeptStoriesIntoTheCache() async throws {
		let (model, stories) = try makeUnreadSectionModel(inFeedCache: false)
		await model.setRead(stories[1], read: true)

		model.retainPresentedArticles(model.articles(for: unread), in: unread)

		#expect(model.allArticles(for: unread).map(\.id) == ["a", "c"])
		await model.refresh(collection: unread)
		#expect(model.articles(for: unread).map(\.id) == ["a", "c"])
	}

	@Test func unstarringAKeptStoryInStarredRemovesIt() async throws {
		let model = try makeModel()
		let stories = makeStories(isRead: false).map { story -> Recommendation in
			var starred = story
			starred.isStarred = true
			return starred
		}
		let starred = ReaderNavigationItem.smart(.starred)
		model.setNavigation(ReaderNavigationState(items: [starred, unread]))
		model.setSortOrder(.oldest, for: starred)
		model.setArticles(stories, for: starred)
		model.select(item: starred)
		model.setArticleFilter(.unread, for: starred)
		await model.setRead(stories[1], read: true)
		#expect(model.articles(for: starred).map(\.id) == ["a", "b", "c"])

		await model.setStarred(stories[1], starred: false)

		#expect(model.articles(for: starred).map(\.id) == ["a", "c"])
	}

	@Test func notInterestedRemovesAKeptStoryFromForYou() async throws {
		let model = try makeModel()
		let stories = makeStories(isRead: false)
		let forYou = ReaderNavigationItem.smart(.forYou)
		model.setNavigation(ReaderNavigationState(items: [forYou, unread]))
		model.setArticles(stories, for: forYou)
		model.select(item: forYou)
		model.setArticleFilter(.unread, for: forYou)
		await model.setRead(stories[1], read: true)
		#expect(model.articles(for: forYou).map(\.id) == ["a", "b", "c"])

		await model.recordPreference(.notInterested, for: stories[1])

		#expect(model.articles(for: forYou).map(\.id) == ["a", "c"])
	}

	@Test func localMidnightDropsKeptTodayStories() async throws {
		let model = try makeModel()
		let day = ReaderLocalDayBounds.localDay(containing: .now).start
		let stories = makeStories(isRead: false, start: day.addingTimeInterval(60))
		let today = ReaderNavigationItem.smart(.today)
		model.setNavigation(ReaderNavigationState(items: [today, unread]))
		model.setSortOrder(.oldest, for: today)
		model.setArticles(stories, for: today)
		model.select(item: today)
		await model.setRead(stories[1], read: true)
		#expect(model.articles(for: today).map(\.id) == ["a", "b", "c"])

		await model.handleLocalDayChange(now: day.addingTimeInterval(86_400 + 60))

		#expect(model.articles(for: today).isEmpty)
	}

	@Test func unsubscribingRemovesItsKeptStories() async throws {
		let (model, stories) = try makeUnreadSectionModel()
		let daily = FeedSubscription(
			id: feed.id, title: "Daily", categories: [],
			url: try #require(URL(string: "https://pigeon.test/feed/daily")), htmlUrl: nil, iconUrl: nil,
		)
		model.setSubscriptions([daily])
		await model.setRead(stories[1], read: true)
		#expect(model.articles(for: unread).map(\.id) == ["a", "b", "c"])

		#expect(await model.unsubscribe(daily))

		#expect(model.articles(for: unread).contains { $0.id == "b" } == false)
	}

	@Test func largeUnreadListWithKeptStoriesStaysFast() async throws {
		let model = try makeModel()
		let stories = (0..<2_000).map { index in
			makeStory(id: "large-\(index)", receivedAt: Date(timeIntervalSince1970: 1_786_272_000 + Double(index)))
		}
		model.setNavigation(ReaderNavigationState(items: [unread]))
		model.setArticles(stories, for: unread)
		model.select(item: unread)
		let clock = ContinuousClock()
		let baselineStart = clock.now
		for _ in 0..<50 { _ = model.articles }
		let baseline = clock.now - baselineStart
		print("50 Unread list reads without kept stories: \(baseline)")
		for index in stride(from: 0, to: 2_000, by: 400) {
			await model.setRead(stories[index], read: true)
		}
		let start = clock.now
		for _ in 0..<50 { _ = model.articles }
		let elapsed = clock.now - start
		print("50 Unread list reads with 5 kept stories: \(elapsed)")
		#expect(model.articles.count == 2_000)
		#expect(model.articles.map(\.id) == stories.reversed().map(\.id))
		// Relative to the no-kept baseline so a loaded CI Mac slows both equally.
		// The fix measures about 2x baseline; re-sorting the list per read was over 9x.
		#expect(elapsed < max(baseline * 5, .milliseconds(50)))
	}

	// MARK: Fixtures

	/// `inFeedCache: false` leaves the Unread section as the only cache holding
	/// the stories, so nothing else can stand in for a dropped kept copy.
	private func makeUnreadSectionModel(inFeedCache: Bool = true) throws -> (ReaderAppModel, [Recommendation]) {
		let model = try makeModel()
		let stories = makeStories(isRead: false)
		model.setNavigation(ReaderNavigationState(items: [unread, feed, otherFeed]))
		model.setSortOrder(.oldest, for: unread)
		model.setArticles(stories, for: unread)
		if inFeedCache { model.setArticles(stories, for: feed) }
		model.select(item: unread)
		return (model, stories)
	}

	private func makeFeedModel(
		filter: ReaderArticleFilter,
		isRead: Bool = false,
	) throws -> (ReaderAppModel, [Recommendation]) {
		let model = try makeModel()
		let stories = makeStories(isRead: isRead)
		model.setNavigation(ReaderNavigationState(items: [unread, feed, otherFeed]))
		model.setSortOrder(.oldest, for: feed)
		model.setArticles(stories, for: feed)
		model.select(item: feed)
		model.setArticleFilter(filter, for: feed)
		return (model, stories)
	}

	private func makeStories(
		isRead: Bool,
		start: Date = Date(timeIntervalSince1970: 1_786_272_000),
	) -> [Recommendation] {
		["a", "b", "c"].enumerated().map { index, id in
			makeStory(id: id, isRead: isRead, receivedAt: start.addingTimeInterval(Double(index)))
		}
	}

	private func makeStory(id: String, isRead: Bool = false, receivedAt: Date) -> Recommendation {
			Recommendation(
				id: id,
				readerId: "tag:google.com,2005:reader/item/\(id)",
				feedKey: "daily",
				source: "Daily",
				title: "Story \(id)",
				html: "<p>Body</p>",
				text: "Body",
				originalURL: nil,
				receivedAt: receivedAt,
				isRead: isRead,
				isStarred: false,
				score: 50,
				confidence: 0,
				sampleCount: 0,
				explanation: "Starting with recency",
				learningState: "Starting with recency",
			)
	}

	private func makeModel() throws -> ReaderAppModel {
		let defaults = try #require(UserDefaults(suiteName: "pigeon-sticky-read-\(UUID().uuidString)"))
		let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "server-token")
		return ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: MockHTTPClient(shouldFail: true),
			readwiseTokenStore: TestReadwiseTokenStore(),
			readerModeStore: ReaderModeStore(defaults: defaults),
			articleFilterStore: ReaderArticleFilterStore(defaults: defaults),
			smartViewStore: ReaderSmartViewStore(defaults: defaults),
			offlineStore: OfflineLibraryStore.inMemory(),
			offlineSynchronizationEnabled: false,
			readerTypography: ReaderTypographySettings(defaults: defaults),
			keyboardShortcuts: ReaderKeyboardShortcutSettings(defaults: defaults),
		)
	}
}
