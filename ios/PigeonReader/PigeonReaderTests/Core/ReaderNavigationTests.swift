import Foundation
import Testing
@testable import PigeonReader

struct ReaderNavigationTests {
	@Test func navigationPayloadDecodesAndMapsSmartFoldersFeedsAndCountsWithoutFolderDoubleCounting() throws {
		let payload = Data(
			"""
			{
				"subscriptions":[
					{"id":"feed/7","title":"Alpha","categories":[{"id":"user/-/label/Work","label":"Work"},{"id":"user/-/label/Work","label":"Work"},{"id":"user/-/label/News","label":"News"}],"url":"https://pigeon.test/feed/alpha","iconUrl":"https://pigeon.test/icons/alpha.png"},
					{"id":"feed/8","title":"Bravo","categories":[{"id":"user/-/label/Work","label":"Work"}],"url":"https://pigeon.test/feed/bravo"},
					{"id":"feed/9","title":"Unfiled","categories":[],"url":"https://pigeon.test/feed/unfiled"}
				],
				"unreadcounts":[
					{"id":"feed/7","count":4,"newestItemTimestampUsec":"0"},
					{"id":"feed/8","count":3,"newestItemTimestampUsec":"0"},
					{"id":"feed/9","count":1,"newestItemTimestampUsec":"0"},
					{"id":"user/-/label/News","count":4,"newestItemTimestampUsec":"0"},
					{"id":"user/-/label/Work","count":7,"newestItemTimestampUsec":"0"},
					{"id":"user/-/state/com.google/reading-list","count":8,"newestItemTimestampUsec":"0"}
				]
			}
			""".utf8,
		)
		let decoder = JSONDecoder()
		let subscriptions = try decoder.decode(ReaderSubscriptionListResponse.self, from: payload).subscriptions
		let unreadCounts = try decoder.decode(ReaderUnreadCountResponse.self, from: payload).unreadCounts
		let state = ReaderNavigationCatalog.make(
			subscriptions: subscriptions,
			unreadCounts: unreadCounts,
			smartCounts: ReaderNavigationSmartCounts(forYou: 2, today: 1, unread: 8, starred: 3),
		)

		let work = try #require(state.folderItems.first(where: { $0.title == "Work" }))
		let workChildren = state.children(of: work.id)
		#expect(work.unreadCount == 7, "A folder count must use the server aggregate once, not sum duplicate labels.")
		#expect(workChildren.count == 2)
		#expect(workChildren.map(\.unreadCount) == [4, 3])
		#expect(workChildren.first(where: { $0.title == "Alpha" })?.iconURL == URL(string: "https://pigeon.test/icons/alpha.png"))
		#expect(state.uncategorizedFeedItems.map(\.title) == ["Unfiled"])
		#expect(state.uncategorizedFeedItems.first?.unreadCount == 1)
		#expect(state.smartItems.first(where: { $0.smartSection == .forYou })?.unreadCount == 2)
		#expect(state.smartItems.first(where: { $0.smartSection == .today })?.unreadCount == 1)
		#expect(state.smartItems.first(where: { $0.smartSection == .unread })?.unreadCount == 8)
		#expect(state.smartItems.first(where: { $0.smartSection == .starred })?.unreadCount == 3)
	}

	@Test func categorySortingUsesLocalizedTitleThenCategoryID() {
		let categories = [
			ReaderSubscriptionCategory(id: "folder/zeta", label: "Zeta"),
			ReaderSubscriptionCategory(id: "folder/same-b", label: "Same"),
			ReaderSubscriptionCategory(id: "folder/alpha", label: "Alpha"),
			ReaderSubscriptionCategory(id: "folder/same-a", label: "Same"),
		]

		let sorted = ReaderNavigationCatalog.uniqueCategories(categories)

		#expect(sorted.map { $0.label ?? "" } == ["Alpha", "Same", "Same", "Zeta"])
		#expect(sorted.map(\.id) == ["folder/alpha", "folder/same-a", "folder/same-b", "folder/zeta"])
	}

	@Test func accessibilityCopyInterpolatesCollectionTitles() {
		#expect(ReaderAccessibilityText.sortStories(for: "Design") == "Sort Design stories")
	}

	@MainActor
	@Test func forYouCountCoversTheCompleteBoundedRecommendationCollection() async throws {
		let first = makeArticle(id: "item-1", feedKey: "feed/7", readerId: "reader-1")
		let second = makeArticle(id: "item-2", feedKey: "feed/8", readerId: "reader-2")
		let response = RecommendationsResponse(generatedAt: .now, view: "for-you", items: [first, second])
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .iso8601
		let client = MockHTTPClient(responseData: try encoder.encode(response))
		let model = try makeModel(httpClient: client)

		await model.load(section: .forYou, force: true)

		#expect(model.articles(for: .forYou).count == 2)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .forYou })?.unreadCount == 2)
		let request = try #require(await client.lastRequest())
		#expect(request.url.query?.contains("limit=30") == true)
	}

	@Test func localTodayUsesInclusiveStartAndExclusiveNextMidnight() throws {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = try #require(TimeZone(identifier: "America/New_York"))
		let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 7, minute: 48)))
		let bounds = ReaderLocalDayBounds.localDay(containing: now, calendar: calendar)

		#expect(bounds.contains(bounds.start))
		#expect(bounds.contains(bounds.end.addingTimeInterval(-1)))
		#expect(bounds.contains(bounds.end) == false)
		#expect(bounds.contains(bounds.start.addingTimeInterval(-1)) == false)
	}

	@MainActor
	@Test func selectingAFeedSelectsItsArticleCollectionAndExpandsItsFolder() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let state = ReaderNavigationCatalog.make(
			subscriptions: [
				ReaderSubscription(id: "feed/7", title: "Alpha", categories: [ReaderSubscriptionCategory(id: "user/-/label/Work", label: "Work")]),
			],
			unreadCounts: [
				ReaderUnreadCount(id: "feed/7", count: 4),
				ReaderUnreadCount(id: "user/-/label/Work", count: 4),
			],
			smartCounts: ReaderNavigationSmartCounts(forYou: 0, today: 0, unread: 4, starred: 0),
		)
		model.setNavigation(state)
		let folder = try #require(model.folderNavigationItems.first)
		let feed = try #require(model.feedNavigationItems(in: folder).first)

		model.select(item: feed)

		#expect(model.selectedNavigationID == feed.id)
		#expect(model.isFolderExpanded(folder))
		#expect(model.selectedCollection.streamID == "feed/7")
	}

	@MainActor
	@Test func refreshUsesPaginatedItemIDsAndServerSideTodayBoundary() async throws {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = try #require(TimeZone(identifier: "America/New_York"))
		let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 7, minute: 48)))
		let bounds = ReaderLocalDayBounds.localDay(containing: now, calendar: calendar)
		let client = NavigationHTTPClient(now: now, dayBounds: bounds)
		let model = try makeModel(httpClient: client)

		await model.loadNavigation(force: true, now: now, dayBounds: bounds)

		#expect(model.folderNavigationItems.first(where: { $0.title == "Work" })?.unreadCount == 7)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .starred })?.unreadCount == 2)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .today })?.unreadCount == 1)
		let requests = await client.requests()
		#expect(requests.contains(where: { $0.path == "/reader/api/0/subscription/list" }))
		#expect(requests.contains(where: { $0.path == "/reader/api/0/unread-count" }))
		#expect(requests.contains(where: { $0.query?.contains("c=starred-2") == true }))
		#expect(requests.contains(where: { $0.query?.contains("c=today-2") == true }))
		#expect(requests.contains(where: { $0.path == "/reader/api/0/stream/contents" }) == false)
		let todayRequest = try #require(requests.first(where: { url in
			guard url.path == "/reader/api/0/stream/items/ids" else {
				return false
			}
			let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
			return queryItems.first(where: { $0.name == "s" })?.value == "user/-/state/com.google/reading-list"
				&& queryItems.first(where: { $0.name == "c" }) == nil
		}))
		let todayQueryItems = URLComponents(url: todayRequest, resolvingAgainstBaseURL: false)?.queryItems ?? []
		#expect(todayQueryItems.first(where: { $0.name == "xt" })?.value == "user/-/state/com.google/read")
		#expect(todayQueryItems.first(where: { $0.name == "ot" })?.value == String(bounds.startSeconds - 1))
		#expect(todayQueryItems.first(where: { $0.name == "n" })?.value == "1000")
	}

	@MainActor
	@Test func smartCountFailureKeepsPreviousSmartCountWhileRefreshingFeedCounts() async throws {
		var calendar = Calendar(identifier: .gregorian)
		calendar.timeZone = try #require(TimeZone(identifier: "America/New_York"))
		let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 8, day: 13, hour: 7, minute: 48)))
		let bounds = ReaderLocalDayBounds.localDay(containing: now, calendar: calendar)
		let client = NavigationHTTPClient(
			now: now,
			dayBounds: bounds,
			failingSmartStreamID: "user/-/state/com.google/reading-list",
		)
		let model = try makeModel(httpClient: client)
		model.setNavigation(
			ReaderNavigationCatalog.make(
				subscriptions: [],
				unreadCounts: [],
				smartCounts: ReaderNavigationSmartCounts(forYou: 0, today: 6, unread: 0, starred: 5),
			),
		)

		await model.loadNavigation(force: true, now: now, dayBounds: bounds)

		#expect(model.folderNavigationItems.first(where: { $0.title == "Work" })?.unreadCount == 7)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .unread })?.unreadCount == 8)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .starred })?.unreadCount == 2)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .today })?.unreadCount == 6)
		#expect(model.errorMessage == nil)
	}

	@MainActor
	@Test func olderNavigationRefreshCannotReplaceNewerSnapshotOrClearLoading() async throws {
		let client = RacingNavigationHTTPClient()
		let model = try makeModel(httpClient: client)

		let olderLoad = Task { await model.loadNavigation(force: true) }
		await client.waitForFirstSnapshot()

		let newerLoad = Task { await model.loadNavigation(force: true) }
		await newerLoad.value

		let currentFolder = try #require(model.folderNavigationItems.first)
		#expect(currentFolder.title == "Fresh")
		#expect(currentFolder.unreadCount == 9)
		#expect(model.isLoadingNavigation)

		await client.releaseFirstSnapshot()
		await olderLoad.value

		let finalFolder = try #require(model.folderNavigationItems.first)
		#expect(finalFolder.title == "Fresh")
		#expect(finalFolder.unreadCount == 9)
		#expect(model.isLoadingNavigation == false)
	}

	@MainActor
	@Test func offlineReadCountChangesStayOptimisticAcrossEveryCollection() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let state = ReaderNavigationCatalog.make(
			subscriptions: [
				ReaderSubscription(id: "feed/7", title: "Alpha", categories: [ReaderSubscriptionCategory(id: "user/-/label/Work", label: "Work")]),
			],
			unreadCounts: [
				ReaderUnreadCount(id: "feed/7", count: 1),
				ReaderUnreadCount(id: "user/-/label/Work", count: 1),
				ReaderUnreadCount(id: "user/-/state/com.google/reading-list", count: 1),
			],
			smartCounts: ReaderNavigationSmartCounts(forYou: 1, today: 1, unread: 1, starred: 1),
		)
		model.setNavigation(state)
		var article = makeArticle(id: "item-1", feedKey: "feed/7", readerId: "tag:google.com,2005:reader/item/0000000000000001")
		article.isStarred = true
		model.setArticles([article], for: .forYou)
		model.setArticles([article], for: .unread)
		model.setArticles([article], for: .today)
		model.setArticles([article], for: .starred)
		model.select(section: .unread)

		let mutation = Task { await model.setRead(article, read: true) }
		let request = await controlled.nextRequest()
		#expect(model.allArticles(for: .unread).first?.isRead == true)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .forYou })?.unreadCount == 0)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .today })?.unreadCount == 0)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .unread })?.unreadCount == 0)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .starred })?.unreadCount == 0)
		#expect(model.folderNavigationItems.first?.unreadCount == 0)
		#expect(model.feedNavigationItems(in: try #require(model.folderNavigationItems.first)).first?.unreadCount == 0)

		await controlled.resolve(request, statusCode: 500)
		await mutation.value

		#expect(model.allArticles(for: .unread).first?.isRead == true)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .forYou })?.unreadCount == 0)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .today })?.unreadCount == 0)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .unread })?.unreadCount == 0)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .starred })?.unreadCount == 0)
		#expect(model.folderNavigationItems.first?.unreadCount == 0)
		#expect(model.feedNavigationItems(in: try #require(model.folderNavigationItems.first)).first?.unreadCount == 0)
		#expect(model.offlineStorageStats.pendingMutationCount == 1)

		var readArticle = article
		readArticle.isRead = true
		let zeroState = ReaderNavigationCatalog.make(
			subscriptions: [ReaderSubscription(id: "feed/7", title: "Alpha", categories: [ReaderSubscriptionCategory(id: "user/-/label/Work", label: "Work")])],
			unreadCounts: [],
			smartCounts: ReaderNavigationSmartCounts(forYou: 0, today: 0, unread: 0, starred: 0),
		)
		model.setNavigation(zeroState)
		model.setArticles([readArticle], for: .forYou)
		model.setArticles([readArticle], for: .unread)
		model.setArticles([readArticle], for: .today)
		model.setArticles([readArticle], for: .starred)

		let unreadMutation = Task { await model.setRead(readArticle, read: false) }
		let unreadRequest = await controlled.nextRequest()
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .forYou })?.unreadCount == 1)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .today })?.unreadCount == 1)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .unread })?.unreadCount == 1)
		#expect(model.smartNavigationItems.first(where: { $0.smartSection == .starred })?.unreadCount == 1)
		await controlled.resolve(unreadRequest)
		await unreadMutation.value
		#expect(model.allArticles(for: .unread).first?.isRead == false)
	}

	private func makeModel(httpClient: any HTTPClient) throws -> ReaderAppModel {
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let session = PigeonSession(baseURL: baseURL, token: "server-token")
		let isolatedDefaults = try #require(UserDefaults(suiteName: "pigeon-article-filter-\(UUID().uuidString)"))
		return ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: httpClient,
			readwiseTokenStore: TestReadwiseTokenStore(),
			articleFilterStore: ReaderArticleFilterStore(defaults: isolatedDefaults),
			offlineStore: OfflineLibraryStore.inMemory(),
		)
	}

	private func makeArticle(id: String, feedKey: String, readerId: String, receivedAt: Date = .now) -> Recommendation {
		Recommendation(
			id: id,
			readerId: readerId,
			feedKey: feedKey,
			source: "Alpha",
			title: "Story",
			html: "<p>Body</p>",
			text: "Body",
			originalURL: nil,
			receivedAt: receivedAt,
			isRead: false,
			isStarred: false,
			score: 50,
			confidence: 0,
			sampleCount: 0,
			explanation: "Starting with recency",
			learningState: "Starting with recency",
		)
	}
}
