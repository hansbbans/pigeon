import Foundation
import SwiftUI
import Testing
@testable import PigeonReader

@MainActor
struct ReaderAppModelTests {
	@Test func explicitOpenDoesNotBannerWhenEngagementItemIsUnknown() async throws {
		let mock = MockHTTPClient(
			responseData: Data(#"{"error":"Unknown item tag:google.com,2005:reader/item/0000000000000001"}"#.utf8),
			statusCode: 404,
		)
		let model = try makeModel(httpClient: mock)
		let article = makeArticle(
			id: "tag:google.com,2005:reader/item/0000000000000001",
			isRead: true,
			readerId: "tag:google.com,2005:reader/item/0000000000000001",
		)
		model.articles = [article]

		await model.recordExplicitOpen(for: article)

		#expect(model.errorMessage == nil)
		let requests = await mock.requests()
		#expect(requests.contains(where: { $0.url.path == "/api/v1/engagement" }))
	}

	@Test func explicitOpenStillBannersWhenEngagementServerFails() async throws {
		let mock = MockHTTPClient(responseData: Data("boom".utf8), statusCode: 500)
		let model = try makeModel(httpClient: mock)
		let article = makeArticle(id: "item-1", isRead: true)
		model.articles = [article]

		await model.recordExplicitOpen(for: article)

		#expect(model.errorMessage != nil)
	}

	@Test func loadReaderViewFallsBackToFeedHTMLWhenTheOriginalPageFails() async throws {
		let extractor = ScriptedReaderViewExtractor(
			urlError: ReaderViewError.httpStatus(404),
			htmlDocument: try ReaderViewDocument(contentHTML: "<p>From feed</p>"),
		)
		let model = try makeModel(httpClient: MockHTTPClient(), readerViewExtractor: extractor)
		var article = makeArticle(id: "item-1", isRead: true)
		article = Recommendation(
			id: article.id,
			readerId: article.readerId,
			feedKey: article.feedKey,
			source: article.source,
			title: article.title,
			html: "<p>Newsletter body that still exists in the feed.</p>",
			text: article.text,
			originalURL: URL(string: "https://example.com/expired"),
			receivedAt: article.receivedAt,
			isRead: article.isRead,
			isStarred: article.isStarred,
			score: article.score,
			confidence: article.confidence,
			sampleCount: article.sampleCount,
			explanation: article.explanation,
			learningState: article.learningState,
		)

		let document = try await model.loadReaderView(for: article)

		#expect(document.contentHTML.contains("From feed"))
		#expect(extractor.extractedHTML?.contains("Newsletter body") == true)
	}

	@Test func loadReaderViewPreservesOriginal404WhenFeedFallbackAlsoFails() async throws {
		let extractor = ScriptedReaderViewExtractor(
			urlError: ReaderViewError.httpStatus(404),
			htmlError: ReaderViewError.extractionFailed,
		)
		let model = try makeModel(httpClient: MockHTTPClient(), readerViewExtractor: extractor)
		var article = makeArticle(id: "item-1", isRead: true)
		article = Recommendation(
			id: article.id,
			readerId: article.readerId,
			feedKey: article.feedKey,
			source: article.source,
			title: article.title,
			html: "<p>Feed content that cannot be extracted either.</p>",
			text: article.text,
			originalURL: URL(string: "https://example.com/expired"),
			receivedAt: article.receivedAt,
			isRead: article.isRead,
			isStarred: article.isStarred,
			score: article.score,
			confidence: article.confidence,
			sampleCount: article.sampleCount,
			explanation: article.explanation,
			learningState: article.learningState,
		)

		await #expect(throws: ReaderViewError.httpStatus(404)) {
			try await model.loadReaderView(for: article)
		}
	}

	@Test func explicitOpenMarksUnreadStoryReadAndDoesNotRepeatDuringActiveMonitoring() async throws {
		let mock = MockHTTPClient()
		let model = try makeModel(httpClient: mock)
		let article = makeArticle(id: "item-1", isRead: false)
		model.articles = [article]

		await model.recordExplicitOpen(for: article)

		#expect(model.allArticles(for: .forYou).first?.isRead == true)
		let requests = await mock.requests()
		#expect(requests.filter { $0.url.path == "/api/v1/engagement" }.count == 1)
		#expect(requests.filter { $0.url.path == "/api/v1/mutations" }.count == 1)
	}

	@Test func navigationAdvancesExplicitlyWithoutSelectingTheFirstStory() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let forYouArticle = makeArticle(id: "for-you")
		let unreadArticle = makeArticle(id: "unread")
		model.setArticles([forYouArticle], for: .forYou)
		model.setArticles([unreadArticle], for: .unread)

		model.select(section: .forYou)
		#expect(model.selectedArticleID == nil)
		#expect(model.preferredCompactColumn == .content)

		model.select(article: forYouArticle)
		#expect(model.selectedArticleID == forYouArticle.id)
		#expect(model.preferredCompactColumn == .detail)

		model.select(section: .unread)
		#expect(model.selectedArticleID == nil)
		#expect(model.preferredCompactColumn == .content)

		model.select(section: .forYou)
		#expect(model.selectedArticleID == forYouArticle.id)
		#expect(model.preferredCompactColumn == .content)

		model.select(article: forYouArticle)
		#expect(model.preferredCompactColumn == .detail)
		model.showFeedColumn()
		#expect(model.preferredCompactColumn == .content)
		#expect(model.selectedArticleID == forYouArticle.id)
	}

	@Test func refreshKeepsTheOpenArticleWhenTheFetchedPageOmitsIt() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let openArticle = makeArticle(id: "open")
		let refreshedArticle = makeArticle(id: "refreshed")

		model.setArticles([openArticle], for: .forYou)
		model.select(article: openArticle)
		model.setArticles([refreshedArticle], for: .forYou)

		#expect(model.selectedArticleID == openArticle.id)
		#expect(model.selectedArticle?.id == openArticle.id)
		#expect(model.preferredCompactColumn == .detail)
		#expect(model.allArticles(for: .forYou).map(\.id).contains(openArticle.id))
	}

	@Test func snapshotApplyKeepsTheOpenArticleWhenTheCollectionOmitsIt() async throws {
		let session = try makeSession(token: "keep-open-snapshot")
		let store = OfflineLibraryStore.inMemory()
		let unread = ReaderNavigationItem.smart(.unread, unreadCount: 2)
		let article = makeArticle(id: "reading-now")
		let other = makeArticle(id: "still-unread")
		let accountID = session.storageIdentity
		try await store.saveNavigation(ReaderNavigationState(items: [unread]), accountID: accountID)
		try await store.saveArticles([article, other], collectionID: unread.id, accountID: accountID)
		try await store.saveRestoration(
			ReaderRestorationState(
				selectedNavigationID: unread.id,
				selectedArticleIDs: [:],
				sortOrders: [:],
				articleFilters: [:],
				sidebarFilter: ReaderSidebarFilter.all.rawValue,
				expandedFolderIDs: [],
				compactColumn: .content,
				readerModes: [:],
				articleScrollOffsets: [:],
			),
			accountID: accountID,
		)

		let model = try makeModel(
			httpClient: MockHTTPClient(shouldFail: true),
			session: session,
			offlineStore: store,
		)
		await model.prepareOfflineLibrary()
		model.select(item: unread)
		model.select(article: article)
		#expect(model.preferredCompactColumn == .detail)

		// Incremental sync rebuilds Unread without the story that was just marked read,
		// and a stale restoration would otherwise send the reader back to the feed list.
		try await store.saveArticles([other], collectionID: unread.id, accountID: accountID)
		try await store.saveRestoration(
			ReaderRestorationState(
				selectedNavigationID: unread.id,
				selectedArticleIDs: [:],
				sortOrders: [:],
				articleFilters: [:],
				sidebarFilter: ReaderSidebarFilter.all.rawValue,
				expandedFolderIDs: [],
				compactColumn: .content,
				readerModes: [:],
				articleScrollOffsets: [:],
			),
			accountID: accountID,
		)
		_ = await model.cleanupOfflineBodies()

		#expect(model.selectedArticleID == article.id)
		#expect(model.selectedArticle?.id == article.id)
		#expect(model.preferredCompactColumn == .detail)
		#expect(model.allArticles(for: .unread).map(\.id).contains(article.id))
	}

	@Test func firstSyncWithoutRestorationKeepsAnArticleOpenedWhileSyncIsInFlight() async throws {
		let session = try makeSession(token: "keep-open-first-sync")
		let store = OfflineLibraryStore.inMemory()
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled, session: session, offlineStore: store)
		let preparation = Task { await model.prepareOfflineLibrary() }
		let syncRequest = await controlled.nextRequest()
		#expect(syncRequest.request.url?.path == "/api/v1/sync")

		let collection = ReaderNavigationItem.smart(.forYou)
		let article = makeArticle(id: "opened-during-first-sync")
		model.setNavigation(ReaderNavigationState(items: [collection]))
		model.setArticles([article], for: collection)
		model.select(item: collection)
		model.select(article: article)
		#expect(model.preferredCompactColumn == .detail)

		await controlled.resolve(syncRequest, data: Data(#"{"cursor":"0","hasMore":false,"changes":[]}"#.utf8))
		let firstPostSyncRequest = await controlled.nextRequest()
		#expect(model.selectedArticle?.id == article.id)
		#expect(model.preferredCompactColumn == .detail)

		func postSyncData(for request: ControlledHTTPClient.PendingRequest) throws -> Data {
			let data: Data
			switch request.request.url?.path {
			case "/reader/api/0/subscription/list":
				data = try subscriptionsData([])
			case "/reader/api/0/unread-count":
				data = Data(#"{"unreadcounts":[]}"#.utf8)
			case "/reader/api/0/stream/items/ids":
				data = Data(#"{"itemRefs":[]}"#.utf8)
			case "/api/v1/recommendations":
				data = try responseData(items: [])
			default:
				data = Data()
			}
			return data
		}
		await controlled.resolve(firstPostSyncRequest, data: try postSyncData(for: firstPostSyncRequest))
		for _ in 0..<5 {
			let request = await controlled.nextRequest()
			await controlled.resolve(request, data: try postSyncData(for: request))
		}
		await preparation.value

		#expect(model.selectedArticleID == article.id)
		#expect(model.selectedArticle?.id == article.id)
		#expect(model.preferredCompactColumn == .detail)
		#expect(model.allArticles(for: collection).map(\.id).contains(article.id))
	}

	@Test func reselectingTheOpenCollectionDoesNotLeaveTheArticle() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let article = makeArticle(id: "open")
		model.setArticles([article], for: .unread)
		model.select(section: .unread)
		model.select(article: article)

		model.select(section: .unread)

		#expect(model.selectedArticleID == article.id)
		#expect(model.preferredCompactColumn == .detail)
	}

	@Test func navigationRefreshDoesNotLeaveAnOpenArticleWhenTheCollectionRowIsMissing() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let feed = ReaderNavigationItem(
			id: "feed/7",
			title: "Alpha",
			streamID: "feed/7",
			kind: .feed,
			unreadCount: 1,
			parentID: nil,
			feedKey: "alpha",
			iconURL: nil,
			smartSection: nil,
		)
		let article = makeArticle(id: "open-feed-article", feedKey: "alpha")
		model.setNavigation(ReaderNavigationState(items: [feed, .smart(.forYou)]))
		model.select(item: feed)
		model.setArticles([article], for: feed)
		model.select(article: article)

		model.setNavigation(ReaderNavigationState(items: [.smart(.forYou)]), markAsLoaded: true)

		#expect(model.selectedArticleID == article.id)
		#expect(model.selectedArticle?.id == article.id)
		#expect(model.preferredCompactColumn == .detail)
	}

	@Test func navigationRefreshKeepsTheSelectedCollectionUntilItReturnsOrChanges() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let feed = ReaderNavigationItem(
			id: "feed/7",
			title: "Alpha",
			streamID: "feed/7",
			kind: .feed,
			unreadCount: 1,
			parentID: nil,
			feedKey: "alpha",
			iconURL: nil,
			smartSection: nil,
		)
		let refreshedFeed = ReaderNavigationItem(
			id: feed.id,
			title: "Alpha (refreshed)",
			streamID: feed.streamID,
			kind: feed.kind,
			unreadCount: 4,
			parentID: feed.parentID,
			feedKey: feed.feedKey,
			iconURL: feed.iconURL,
			smartSection: feed.smartSection,
		)
		let forYou = ReaderNavigationItem.smart(.forYou)

		model.setNavigation(ReaderNavigationState(items: [forYou, feed]))
		model.select(item: feed)
		model.setNavigation(ReaderNavigationState(items: [forYou]), markAsLoaded: true)

		#expect(model.selectedNavigationID == feed.id)
		#expect(model.selectedCollection.id == feed.id)
		#expect(model.selectedCollection.title == feed.title)

		model.setNavigation(ReaderNavigationState(items: [forYou, refreshedFeed]), markAsLoaded: true)
		#expect(model.selectedCollection.title == refreshedFeed.title)
		#expect(model.selectedCollection.unreadCount == refreshedFeed.unreadCount)

		model.setNavigation(ReaderNavigationState(items: [forYou]), markAsLoaded: true)
		model.select(section: .forYou)
		#expect(model.selectedNavigationID == forYou.id)
		#expect(model.selectedCollection.id == forYou.id)
	}

	@Test func snapshotApplyKeepsTheSelectedCollectionWhenItsNavigationRowIsMissing() async throws {
		let session = try makeSession(token: "keep-selected-collection")
		let store = OfflineLibraryStore.inMemory()
		let accountID = session.storageIdentity
		let forYou = ReaderNavigationItem.smart(.forYou)
		let feed = ReaderNavigationItem(
			id: "feed/7",
			title: "Alpha",
			streamID: "feed/7",
			kind: .feed,
			unreadCount: 1,
			parentID: nil,
			feedKey: "alpha",
			iconURL: nil,
			smartSection: nil,
		)
		let refreshedFeed = ReaderNavigationItem(
			id: feed.id,
			title: "Alpha (refreshed)",
			streamID: feed.streamID,
			kind: feed.kind,
			unreadCount: 4,
			parentID: feed.parentID,
			feedKey: feed.feedKey,
			iconURL: feed.iconURL,
			smartSection: feed.smartSection,
		)
		let article = makeArticle(id: "open-feed-article", feedKey: "alpha")
		try await store.saveNavigation(ReaderNavigationState(items: [forYou, feed]), accountID: accountID)
		try await store.saveArticles([article], collectionID: feed.id, accountID: accountID)
		try await store.saveRestoration(
			ReaderRestorationState(
				selectedNavigationID: feed.id,
				selectedArticleIDs: [:],
				sortOrders: [:],
				articleFilters: [:],
				sidebarFilter: ReaderSidebarFilter.all.rawValue,
				expandedFolderIDs: [],
				compactColumn: ReaderRestoredCompactColumn.content,
				readerModes: [:],
				articleScrollOffsets: [:],
			),
			accountID: accountID,
		)

		let model = try makeModel(
			httpClient: MockHTTPClient(shouldFail: true),
			session: session,
			offlineStore: store,
		)
		await model.prepareOfflineLibrary()
		model.select(item: feed)
		model.select(article: article)

		try await store.saveNavigation(ReaderNavigationState(items: [forYou]), accountID: accountID)
		_ = await model.cleanupOfflineBodies()
		#expect(model.selectedNavigationID == feed.id)
		#expect(model.selectedCollection.id == feed.id)
		#expect(model.selectedCollection.title == feed.title)
		#expect(model.preferredCompactColumn == .detail)

		try await store.saveNavigation(ReaderNavigationState(items: [forYou, refreshedFeed]), accountID: accountID)
		_ = await model.cleanupOfflineBodies()
		#expect(model.selectedCollection.title == refreshedFeed.title)
		#expect(model.selectedCollection.unreadCount == refreshedFeed.unreadCount)
	}

	@Test func refreshPreservesOpenArticleWhenCollectionRekeysTheSameLogicalArticle() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let collection = ReaderNavigationItem.smart(.forYou)
		let initiallyLoaded = makeArticle(id: "recommendation-id", readerId: "stable-reader-id")
		let refreshed = makeArticle(id: "stream-id", readerId: initiallyLoaded.readerId)
		model.setNavigation(ReaderNavigationState(items: [collection]))

		let initialLoad = Task { await model.load(collection: collection, force: true) }
		let initialRequest = await controlled.nextRequest()
		await controlled.resolve(initialRequest, data: try responseData(items: [initiallyLoaded]))
		await initialLoad.value
		model.select(item: collection)
		model.select(article: initiallyLoaded)

		let refresh = Task { await model.load(collection: collection, force: true) }
		let refreshRequest = await controlled.nextRequest()
		await controlled.resolve(refreshRequest, data: try responseData(items: [refreshed]))
		await refresh.value

		#expect(model.selectedArticleID == refreshed.id)
		#expect(model.selectedArticle?.id == refreshed.id)
		#expect(model.preferredCompactColumn == .detail)
		#expect(model.allArticles(for: collection).map(\.id) == [refreshed.id])
	}

	@Test func articleShortcutsFollowTheDisplayedCollectionOrderAndStopAtBoundaries() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let collection = ReaderNavigationItem.smart(.forYou)
		let otherCollection = ReaderNavigationItem.smart(.unread)
		let first = makeArticle(id: "first", receivedAt: 1)
		let middle = makeArticle(id: "middle", receivedAt: 2)
		let last = makeArticle(id: "last", receivedAt: 3)
		let unrelated = makeArticle(id: "unrelated", receivedAt: 4)

		model.setNavigation(ReaderNavigationState(items: [collection, otherCollection]))
		model.setSortOrder(.oldest, for: collection)
		model.setArticles([last, first, middle], for: collection)
		model.setArticles([unrelated], for: otherCollection)
		model.select(item: collection)
		model.select(article: middle)

		#expect(model.navigateArticle(.next)?.id == "last")
		#expect(model.selectedArticleID == "last")
		#expect(model.navigateArticle(.next) == nil)
		#expect(model.selectedArticleID == "last")
		#expect(model.navigateArticle(.previous)?.id == "middle")
		#expect(model.navigateArticle(.previous)?.id == "first")
		#expect(model.navigateArticle(.previous) == nil)
		#expect(model.selectedArticleID == "first")
	}

	@Test func articleShortcutsFollowVisibleLibrarySearchResultsAcrossCollections() async throws {
		let store = OfflineLibraryStore.inMemory()
		let model = try makeModel(httpClient: MockHTTPClient(), offlineStore: store)
		let collection = ReaderNavigationItem.smart(.forYou)
		let otherCollection = ReaderNavigationItem.smart(.unread)
		let current = makeArticle(id: "current", receivedAt: 1)
		let other = makeArticle(id: "other", receivedAt: 2)
		let accountID = try #require(model.session?.storageIdentity)

		model.setNavigation(ReaderNavigationState(items: [collection, otherCollection]))
		model.setSortOrder(.oldest, for: collection)
		model.setArticles([current], for: collection)
		model.setArticles([other], for: otherCollection)
		try await store.saveArticles([current], collectionID: collection.id, accountID: accountID)
		try await store.saveArticles([other], collectionID: otherCollection.id, accountID: accountID)
		model.select(item: collection)
		model.select(article: current)

		await model.searchArticles(query: "Story", scope: .library, in: collection)

		#expect(model.searchResults.map(\.id) == [current.id, other.id])
		model.select(item: otherCollection)
		model.select(article: current)
		#expect(model.navigateArticle(.next)?.id == other.id)
		#expect(model.selectedArticleID == other.id)
	}

	@Test func notInterestedRemovesAndClearsForYouSelectionButKeepsUnread() async throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let article = makeArticle(id: "shared")
		model.setArticles([article], for: .forYou)
		model.setArticles([article], for: .unread)
		model.select(section: .forYou)
		model.select(article: article)

		await model.recordPreference(.notInterested, for: article)

		#expect(model.articles(for: .forYou).isEmpty)
		#expect(model.articles(for: .unread).map(\.id) == [article.id])
		#expect(model.selectedArticleID == nil)
		#expect(model.preferredCompactColumn == .content)
	}

	@Test func offlineReadStaysOptimisticAndQueuedWhenRequestFails() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let article = makeArticle(id: "shared", isRead: false)
		model.setArticles([article], for: .forYou)
		model.setArticles([article], for: .starred)

		let mutation = Task { await model.setRead(article, read: true) }
		let request = await controlled.nextRequest()

		#expect(model.allArticles(for: .forYou).first?.isRead == true)
		#expect(model.allArticles(for: .starred).first?.isRead == true)

		await controlled.resolve(request, statusCode: 500)
		await mutation.value

		#expect(model.allArticles(for: .forYou).first?.isRead == true)
		#expect(model.allArticles(for: .starred).first?.isRead == true)
		#expect(model.offlineStorageStats.pendingMutationCount == 1)
		#expect(model.isOffline == false)
	}

	@Test func cachedLibraryAndReadingPositionRestoreBeforeAnOfflineRefreshFails() async throws {
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let session = PigeonSession(baseURL: baseURL, token: "offline-account")
		let store = OfflineLibraryStore.inMemory()
		let article = makeArticle(id: "cached-article", isRead: false)
		let navigation = ReaderNavigationState(
			items: [.smart(.forYou, unreadCount: 1)],
			expandedFolderIDs: [],
		)
		let restoration = ReaderRestorationState(
			selectedNavigationID: ReaderSection.forYou.rawValue,
			selectedArticleIDs: [ReaderSection.forYou.rawValue: article.id],
			sortOrders: [:],
			articleFilters: [:],
			sidebarFilter: ReaderSidebarFilter.all.rawValue,
			expandedFolderIDs: [],
			compactColumn: .detail,
			readerModes: [article.feedKey: ReaderMode.readerView.rawValue],
			articleScrollOffsets: [article.id: 0.72],
		)
		try await store.saveNavigation(navigation, accountID: session.storageIdentity)
		try await store.saveArticles([article], collectionID: ReaderSection.forYou.rawValue, accountID: session.storageIdentity)
		try await store.saveRestoration(restoration, accountID: session.storageIdentity)
		let model = try makeModel(
			httpClient: MockHTTPClient(shouldFail: true),
			session: session,
			offlineStore: store,
		)

		await model.prepareOfflineLibrary()

		#expect(model.isOffline)
		#expect(model.articles(for: .forYou).map(\.id) == [article.id])
		#expect(model.selectedArticleID == article.id)
		#expect(model.readerMode(for: article.feedKey) == .readerView)
		#expect(model.articleScrollOffset(for: article.id) == 0.72)
		#expect(model.preferredCompactColumn == .detail)

		model.showFeedColumn()
		#expect(model.preferredCompactColumn == .content)
		#expect(model.selectedArticleID == article.id)

		_ = await model.cleanupOfflineBodies()
		#expect(model.preferredCompactColumn == .content)
		#expect(model.selectedArticleID == article.id)
	}

	@Test func serverSyncFailureSurfacesAnErrorWithoutShowingOffline() async throws {
		let model = try makeModel(
			httpClient: MockHTTPClient(responseData: Data("server unavailable".utf8), statusCode: 503)
		)

		await model.prepareOfflineLibrary()

		#expect(model.isOffline == false)
		#expect(model.errorMessage != nil)
	}

	@Test func connectivitySyncFailureStillShowsOffline() async throws {
		let model = try makeModel(
			httpClient: MockHTTPClient(failure: URLError(.notConnectedToInternet))
		)

		await model.prepareOfflineLibrary()

		#expect(model.isOffline)
		#expect(model.errorMessage == URLError(.notConnectedToInternet).localizedDescription)
	}

	@Test func successfulCollectionLoadClearsStaleOfflineState() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)

		let preparation = Task { await model.prepareOfflineLibrary() }
		let syncRequest = await controlled.nextRequest()
		await controlled.fail(syncRequest, with: URLError(.notConnectedToInternet))
		await preparation.value
		#expect(model.isOffline)

		let load = Task { await model.load(section: .forYou, force: true) }
		let collectionRequest = await controlled.nextRequest()
		await controlled.resolve(collectionRequest, data: try responseData(items: [makeArticle(id: "live")]))
		await load.value

		#expect(model.isOffline == false)
		#expect(model.articles(for: .forYou).map(\.id) == ["live"])
	}

	@Test func cachedSelectedFolderArticlesAreAvailableBeforeOfflinePreparationSyncFinishes() async throws {
		let session = try makeSession(token: "cached-folder-preparation")
		let store = OfflineLibraryStore.inMemory()
		let subscription = makeSubscription(id: "feed/7", key: "alpha", title: "Alpha", folder: "News")
		let readerSubscription = ReaderSubscription(
			id: subscription.id,
			title: subscription.title,
			categories: [ReaderSubscriptionCategory(id: "user/-/label/News", label: "News")],
			url: subscription.url.absoluteString,
		)
		let folderID = "user/-/label/News"
		let cachedArticles = (0..<5).map { makeArticle(id: "cached-folder-\($0)") }
		let navigation = ReaderNavigationCatalog.make(
			subscriptions: [readerSubscription],
			unreadCounts: [],
			smartCounts: ReaderNavigationSmartCounts(forYou: 0, today: 0, unread: 0, starred: 0),
		)
		let restoration = ReaderRestorationState(
			selectedNavigationID: folderID,
			selectedArticleIDs: [folderID: cachedArticles[0].id],
			sortOrders: [:],
			articleFilters: [:],
			sidebarFilter: ReaderSidebarFilter.all.rawValue,
			expandedFolderIDs: [],
			compactColumn: .content,
			readerModes: [:],
			articleScrollOffsets: [:],
		)
		let accountID = session.storageIdentity
		try await store.saveNavigation(navigation, accountID: accountID)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveArticles(cachedArticles, collectionID: folderID, accountID: accountID)
		try await store.saveRestoration(restoration, accountID: accountID)

		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled, session: session, offlineStore: store)
		let started = DispatchTime.now().uptimeNanoseconds
		let preparation = Task { await model.prepareOfflineLibrary() }
		let syncRequest = await controlled.nextRequest()
		let elapsed = DispatchTime.now().uptimeNanoseconds - started
		let folder = try #require(model.folderNavigationItems.first)

		#expect(syncRequest.request.url?.path == "/api/v1/sync")
		#expect(model.articles(for: folder).map(\.id) == cachedArticles.map(\.id))
		print("ReaderAppModel cached selected-folder availability: \(String(format: "%.1f", Double(elapsed) / 1_000_000)) ms before sync response")

		await controlled.fail(syncRequest, with: URLError(.notConnectedToInternet))
		await preparation.value
		#expect(model.isOffline)
	}

	@Test func olderOfflinePreparationCannotOverwriteNewerSuccessfulPreparation() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let syncData = Data(#"{"cursor":"0","hasMore":false,"changes":[]}"#.utf8)

		let older = Task { await model.prepareOfflineLibrary() }
		let olderSync = await controlled.nextRequest()
		#expect(olderSync.request.url?.path == "/api/v1/sync")

		let newer = Task { await model.prepareOfflineLibrary() }
		let newerSync = await controlled.nextRequest()
		#expect(newerSync.request.url?.path == "/api/v1/sync")
		await controlled.resolve(newerSync, data: syncData)

		// A successful preparation refreshes navigation, the subscription library, and
		// the selected collection before it completes. Resolve those live requests so
		// the older failure below is observed only after the newer preparation is done.
		for _ in 0..<6 {
			let request = await controlled.nextRequest()
			let path = request.request.url?.path
			let data: Data
			switch path {
			case "/reader/api/0/subscription/list":
				data = try subscriptionsData([])
			case "/api/v1/recommendations":
				data = try responseData(items: [])
			default:
				data = Data(#"{"itemRefs":[],"unreadcounts":[]}"#.utf8)
			}
			await controlled.resolve(request, data: data)
		}
		await newer.value
		#expect(model.isOffline == false)

		await controlled.fail(olderSync, with: URLError(.notConnectedToInternet))
		await older.value

		#expect(model.isOffline == false)
	}

	@Test func olderSuccessfulPreparationCannotClearNewerOfflineFailure() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let syncData = Data(#"{"cursor":"0","hasMore":false,"changes":[]}"#.utf8)

		let older = Task { await model.prepareOfflineLibrary() }
		let olderSync = await controlled.nextRequest()
		await controlled.resolve(olderSync, data: syncData)

		var olderNavigationRequests: [ControlledHTTPClient.PendingRequest] = []
		for _ in 0..<4 {
			olderNavigationRequests.append(await controlled.nextRequest())
		}

		let newer = Task { await model.prepareOfflineLibrary() }
		let newerSync = await controlled.nextRequest()
		await controlled.fail(newerSync, with: URLError(.notConnectedToInternet))
		await newer.value
		#expect(model.isOffline)

		for request in olderNavigationRequests {
			let path = request.request.url?.path
			let data: Data
			switch path {
			case "/reader/api/0/subscription/list":
				data = try subscriptionsData([])
			default:
				data = Data(#"{"itemRefs":[],"unreadcounts":[]}"#.utf8)
			}
			await controlled.resolve(request, data: data)
		}
		await older.value

		#expect(model.isOffline)
	}

	@Test func failedNavigationRefreshStillShowsConnectedFeedNavigationWhenForYouLoads() async throws {
		let subscriptions = [makeSubscription(id: "feed/7", key: "alpha", title: "Alpha", folder: "Newsletters")]
		let client = StartupHTTPClient(
			subscriptionsData: try subscriptionsData(subscriptions),
			recommendationsData: try responseData(items: (0..<30).map { makeArticle(id: "recommendation-\($0)") }),
		)
		let model = try makeModel(httpClient: client)

		await model.prepareOfflineLibrary()

		#expect(model.articles(for: .forYou).count == 30)
		#expect(model.subscriptions == subscriptions)
		#expect(model.folderNavigationItems.map(\.title) == ["Newsletters"])
		if let folder = model.folderNavigationItems.first {
			#expect(model.feedNavigationItems(in: folder).map(\.title) == ["Alpha"])
		}
	}

	@Test func emptyAccountKeepsSmartNavigationWhenForYouLoads() async throws {
		let client = StartupHTTPClient(
			subscriptionsData: try subscriptionsData([]),
			recommendationsData: try responseData(items: (0..<30).map { makeArticle(id: "recommendation-\($0)") }),
		)
		let model = try makeModel(httpClient: client)

		await model.prepareOfflineLibrary()

		#expect(model.articles(for: .forYou).count == 30)
		#expect(model.folderNavigationItems.isEmpty)
		#expect(model.uncategorizedFeedNavigationItems.isEmpty)
	}

	@Test func cancelledReadMutationDoesNotSetErrorMessage() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let article = makeArticle(id: "shared", isRead: false)
		model.setArticles([article], for: .forYou)

		let mutation = Task { await model.setRead(article, read: true) }
		let request = await controlled.nextRequest()
		await controlled.fail(request, with: URLError(.cancelled))
		await mutation.value

		#expect(model.allArticles(for: .forYou).first?.isRead == true)
		#expect(model.errorMessage == nil)
		#expect(model.offlineStorageStats.pendingMutationCount == 1)
	}

	@Test func cancelledURLSessionLoadDoesNotSetErrorMessage() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)

		let load = Task { await model.load(section: .forYou, force: true) }
		let request = await controlled.nextRequest()
		await controlled.fail(request, with: URLError(.cancelled))
		await load.value

		#expect(model.errorMessage == nil)
		#expect(model.articles(for: .forYou).isEmpty)
	}

	@Test func cancelledNSURLErrorLoadDoesNotSetErrorMessage() async throws {
		let model = try makeModel(
			httpClient: MockHTTPClient(failure: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)),
		)

		await model.load(section: .forYou, force: true)

		#expect(model.errorMessage == nil)
	}

	@Test func realLoadFailureStillSetsErrorMessage() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)

		let load = Task { await model.load(section: .forYou, force: true) }
		let request = await controlled.nextRequest()
		await controlled.fail(request, with: URLError(.notConnectedToInternet))
		await load.value

		#expect(model.errorMessage == URLError(.notConnectedToInternet).localizedDescription)
	}

	@Test func folderLoadPaginatesOnlyOnExplicitLoadMoreAndRefreshResetsContinuation() async throws {
		let httpClient = PaginationHTTPClient()
		let store = OfflineLibraryStore.inMemory()
		let model = try makeModel(httpClient: httpClient, offlineStore: store)
		let collection = makePaginationCollection()
		let accountID = try #require(model.session?.storageIdentity)

		await model.load(collection: collection)

		#expect(model.allArticles(for: collection).map(\.id) == ["newest", "middle"])
		#expect(model.canLoadMore(collection: collection))
		let initialRequests = await httpClient.requests()
		#expect(initialRequests.filter { $0.path == "/reader/api/0/stream/items/ids" }.count == 1)
		#expect(initialRequests.filter { $0.path == "/reader/api/0/stream/items/contents" }.count == 1)

		await model.loadMore(collection: collection)

		#expect(model.allArticles(for: collection).map(\.id) == ["newest", "middle", "older"])
		#expect(model.canLoadMore(collection: collection) == false)
		let persisted = try await store.loadSnapshot(accountID: accountID)
		#expect(persisted.articlesByCollection[collection.id]?.map(\.id) == ["newest", "middle", "older"])

		await model.refresh(collection: collection)

		#expect(model.allArticles(for: collection).map(\.id) == ["newest", "middle"])
		#expect(model.canLoadMore(collection: collection))
		let requests = await httpClient.requests()
		let itemIDRequests = requests.filter { $0.path == "/reader/api/0/stream/items/ids" }
		#expect(itemIDRequests.count == 3)
		#expect(itemIDRequests.map { $0.query["c"] } == [nil, "page-2", nil])
		#expect(requests.filter { $0.path == "/reader/api/0/stream/items/contents" }.count == 3)
	}

	@Test func repeatedFolderContinuationStopsWithoutAppendingDuplicateArticlesOrRequestingAgain() async throws {
		let httpClient = PaginationHTTPClient(repeatsContinuation: true)
		let model = try makeModel(httpClient: httpClient)
		let collection = makePaginationCollection()

		await model.load(collection: collection)
		await model.loadMore(collection: collection)

		#expect(model.allArticles(for: collection).map(\.id) == ["newest", "middle", "older"])
		#expect(model.canLoadMore(collection: collection) == false)
		let requestCount = await httpClient.requests().count

		await model.loadMore(collection: collection)

		#expect(await httpClient.requests().count == requestCount)
		#expect(model.allArticles(for: collection).map(\.id) == ["newest", "middle", "older"])
	}

	@Test func failedFolderRefreshKeepsThePreviousContinuationAvailable() async throws {
		let httpClient = PaginationHTTPClient()
		let model = try makeModel(httpClient: httpClient)
		let collection = makePaginationCollection()

		await model.load(collection: collection)
		await httpClient.failNextItemIDRequest()
		await model.refresh(collection: collection)

		#expect(model.allArticles(for: collection).map(\.id) == ["newest", "middle"])
		#expect(model.canLoadMore(collection: collection))
	}

	@Test func supersededLoadMoreCannotOverwriteRefreshOrOfflineState() async throws {
		let controlled = ControlledHTTPClient()
		let store = PausingOfflineLibraryStore()
		let model = try makeModel(httpClient: controlled, offlineStore: store)
		let collection = ReaderNavigationItem.smart(.today)
		let accountID = try #require(model.session?.storageIdentity)

		let initialLoad = Task { await model.load(collection: collection, force: true) }
		let initialIDs = await controlled.nextRequest()
		await controlled.resolve(initialIDs, data: streamIDsData(ids: ["initial"], continuation: "old-next"))
		let initialContents = await controlled.nextRequest()
		await controlled.resolve(initialContents, data: streamContentsData(ids: ["initial"]))
		await initialLoad.value
		#expect(model.errorMessage == nil)
		#expect(model.allArticles(for: collection).map(\.id) == ["initial"])
		#expect(model.canLoadMore(collection: collection))

		await store.pauseNextArticleSave()
		let loadMore = Task { await model.loadMore(collection: collection) }
		let staleIDs = await controlled.nextRequest()
		await controlled.resolve(staleIDs, data: streamIDsData(ids: ["stale"], continuation: nil))
		let staleContents = await controlled.nextRequest()
		await controlled.resolve(staleContents, data: streamContentsData(ids: ["stale"]))
		await store.waitUntilArticleSaveIsPaused()

		let refresh = Task { await model.refresh(collection: collection) }
		let freshIDs = await controlled.nextRequest()
		await controlled.resolve(freshIDs, data: streamIDsData(ids: ["fresh"], continuation: "fresh-next"))
		let freshContents = await controlled.nextRequest()
		await controlled.resolve(freshContents, data: streamContentsData(ids: ["fresh"]))

		// Let the superseded write finish only after the refresh has invalidated it and
		// received its newer page. The current refresh must be the final durable writer.
		await store.resumeArticleSave()
		await loadMore.value
		await refresh.value

		#expect(model.allArticles(for: collection).map(\.id) == ["fresh"])
		#expect(model.canLoadMore(collection: collection))
		#expect(model.navigation.item(withID: collection.id)?.unreadCount == 1)
		let snapshot = try await store.loadSnapshot(accountID: accountID)
		#expect(snapshot.articlesByCollection[collection.id]?.map(\.id) == ["fresh"])
		#expect(snapshot.navigation?.item(withID: collection.id)?.unreadCount == 1)
	}

	@Test func restoredCachedFolderResolvesPaginationOnceWhenSelectedOnline() async throws {
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let session = PigeonSession(baseURL: baseURL, token: "cached-folder-account")
		let store = OfflineLibraryStore.inMemory()
		let subscription = makeSubscription(id: "feed/7", key: "alpha", title: "Alpha", folder: "News")
		let readerSubscription = ReaderSubscription(
			id: subscription.id,
			title: subscription.title,
			categories: [ReaderSubscriptionCategory(id: "user/-/label/News", label: "News")],
			url: subscription.url.absoluteString,
		)
		let navigation = ReaderNavigationCatalog.make(
			subscriptions: [readerSubscription],
			unreadCounts: [],
			smartCounts: ReaderNavigationSmartCounts(forYou: 0, today: 0, unread: 0, starred: 0),
		)
		let cachedArticle = makeArticle(id: "cached-folder")
		let restoration = ReaderRestorationState(
			selectedNavigationID: ReaderSection.forYou.rawValue,
			selectedArticleIDs: [:],
			sortOrders: [:],
			articleFilters: [:],
			sidebarFilter: ReaderSidebarFilter.all.rawValue,
			expandedFolderIDs: [],
			compactColumn: .content,
			readerModes: [:],
			articleScrollOffsets: [:],
		)
		let accountID = session.storageIdentity
		try await store.saveNavigation(navigation, accountID: accountID)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveArticles([cachedArticle], collectionID: "user/-/label/News", accountID: accountID)
		try await store.saveRestoration(restoration, accountID: accountID)

		let client = StartupHTTPClient(
			subscriptionsData: try subscriptionsData([subscription]),
			recommendationsData: try responseData(items: [makeArticle(id: "for-you")]),
			folderItemID: "live-folder",
		)
		let model = try makeModel(httpClient: client, session: session, offlineStore: store)

		await model.prepareOfflineLibrary()
		let folder = try #require(model.folderNavigationItems.first)
		#expect(model.articles(for: folder).map(\.id) == [cachedArticle.id])

		model.select(item: folder)
		await model.load(collection: folder)
		#expect(await client.folderPageRequestCount() == 1)
		#expect(model.articles(for: folder).map(\.id) == ["live-folder"])

		await model.load(collection: folder)
		#expect(await client.folderPageRequestCount() == 1)
	}

	@Test func cloudflareResourceLimitStillSurfacesOnLoad() async throws {
		let payload = Data(
			"""
			{"title":"Error 1102: Worker exceeded resource limits","status":503,"error_code":1102,"error_name":"worker_exceeded_resources","ray_id":"a2aacd260d7a1c3f"}
			""".utf8,
		)
		let model = try makeModel(httpClient: MockHTTPClient(responseData: payload, statusCode: 503))

		await model.load(section: .forYou, force: true)

		#expect(model.errorMessage?.contains("Cloudflare 1102") == true)
		#expect(model.errorMessage?.contains("a2aacd260d7a1c3f") == true)
	}

	@Test func cancelledURLSessionNavigationLoadDoesNotSetErrorMessage() async throws {
		let model = try makeModel(httpClient: MockHTTPClient(failure: URLError(.cancelled)))

		await model.loadNavigation(force: true)

		#expect(model.errorMessage == nil)
	}

	@Test func realNavigationFailureStillSetsErrorMessage() async throws {
		let model = try makeModel(httpClient: MockHTTPClient(failure: URLError(.notConnectedToInternet)))

		await model.loadNavigation(force: true)

		#expect(model.errorMessage == URLError(.notConnectedToInternet).localizedDescription)
	}

	@Test func cancelledURLSessionLibraryLoadDoesNotSetErrorMessage() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)

		let load = Task { await model.loadLibrary(force: true) }
		let request = await controlled.nextRequest()
		await controlled.fail(request, with: URLError(.cancelled))
		await load.value

		#expect(model.errorMessage == nil)
		#expect(model.subscriptions.isEmpty)
	}

	@Test func cancelledURLSessionConnectDoesNotSetErrorMessage() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		model.serverURLText = "https://pigeon.test"
		model.password = "secret"

		let connect = Task { await model.connect() }
		let request = await controlled.nextRequest()
		await controlled.fail(request, with: URLError(.cancelled))
		await connect.value

		#expect(model.errorMessage == nil)
	}

	@Test func isCancellationMatchesTaskAndURLSessionCancellationOnly() {
		#expect(isCancellation(CancellationError()))
		#expect(isCancellation(URLError(.cancelled)))
		#expect(isCancellation(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)))
		#expect(isCancellation(URLError(.notConnectedToInternet)) == false)
		#expect(isCancellation(PigeonError.invalidResponse) == false)
		#expect(isCancellation(PigeonError.server(statusCode: 503, message: "down")) == false)
	}

	@Test func isConnectivityFailureMatchesReachabilityErrorsButNotServerOrDecodeErrors() {
		let connectivityCodes: [URLError.Code] = [
			.notConnectedToInternet,
			.networkConnectionLost,
			.timedOut,
			.cannotFindHost,
			.cannotConnectToHost,
			.dnsLookupFailed,
			.internationalRoamingOff,
			.callIsActive,
			.dataNotAllowed,
		]
		for code in connectivityCodes {
			#expect(isConnectivityFailure(URLError(code)))
		}
		#expect(isConnectivityFailure(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)))
		#expect(isConnectivityFailure(URLError(.badServerResponse)) == false)
		#expect(isConnectivityFailure(PigeonError.server(statusCode: 503, message: "down")) == false)
		#expect(isConnectivityFailure(PigeonError.authenticationFailed) == false)
		#expect(isConnectivityFailure(PigeonError.invalidResponse) == false)
		let decodingError = DecodingError.dataCorrupted(
			.init(codingPath: [], debugDescription: "bad payload")
		)
		#expect(isConnectivityFailure(decodingError) == false)
	}

	@Test func olderLoadCannotReplaceASectionWithStaleResults() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)

		let olderLoad = Task { await model.load(section: .forYou, force: true) }
		let olderRequest = await controlled.nextRequest()
		let newerLoad = Task { await model.load(section: .forYou, force: true) }
		let newerRequest = await controlled.nextRequest()

		await controlled.resolve(newerRequest, data: try responseData(items: [makeArticle(id: "newer")]))
		await newerLoad.value
		await controlled.resolve(olderRequest, data: try responseData(items: [makeArticle(id: "older")]))
		await olderLoad.value

		#expect(model.articles(for: .forYou).map(\.id) == ["newer"])
	}

	@Test(arguments: ReaderSection.allCases)
	func everySectionSortsByNewestOrScoreWithoutLosingSelection(section: ReaderSection) throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let olderHighScore = makeArticle(id: "older-high", receivedAt: 1_786_100_000, score: 90)
		let newerHighScore = makeArticle(id: "newer-high", receivedAt: 1_786_200_000, score: 90)
		let newestLowScore = makeArticle(id: "newest-low", receivedAt: 1_786_300_000, score: 10)
		model.setArticles([olderHighScore, newestLowScore, newerHighScore], for: section)
		model.select(section: section)
		model.select(article: newerHighScore)

		model.setSortOrder(.newest, for: section)
		#expect(model.articles(for: section).map(\.id) == ["newest-low", "newer-high", "older-high"])
		#expect(model.selectedArticleID == newerHighScore.id)

		model.setSortOrder(.score, for: section)
		#expect(model.articles(for: section).map(\.id) == ["newer-high", "older-high", "newest-low"])
		#expect(model.selectedArticleID == newerHighScore.id)

		model.setSortOrder(.oldest, for: section)
		#expect(model.articles(for: section).map(\.id) == ["older-high", "newer-high", "newest-low"])
		#expect(model.selectedArticleID == newerHighScore.id)
	}

	@Test func sortDefaultsPreserveExistingServerOrdering() throws {
		let model = try makeModel(httpClient: MockHTTPClient())

		#expect(model.sortOrder(for: .forYou) == .score)
		#expect(model.sortOrder(for: .unread) == .newest)
		#expect(model.sortOrder(for: .starred) == .newest)
	}

	@Test(arguments: [ReaderNavigationKind.smart, ReaderNavigationKind.folder, ReaderNavigationKind.feed])
	func articleFilterShowsAllUnreadAndReadForEveryCollection(kind: ReaderNavigationKind) throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let state = try makeNavigationState(unreadCount: 2)
		model.setNavigation(state)

		let collection: ReaderNavigationItem
		switch kind {
		case .smart:
			collection = try #require(model.smartNavigationItems.first(where: { $0.smartSection == .forYou }))
		case .folder:
			collection = try #require(model.folderNavigationItems.first)
		case .feed:
			let folder = try #require(model.folderNavigationItems.first)
			collection = try #require(model.feedNavigationItems(in: folder).first)
		}

		model.setSortOrder(.newest, for: collection)
		let newestUnread = makeArticle(id: "newest-unread", receivedAt: 1_786_272_200)
		let olderRead = makeArticle(id: "older-read", isRead: true, receivedAt: 1_786_272_100)
		model.setArticles([olderRead, newestUnread], for: collection)
		model.select(item: collection)

		#expect(model.articleFilter == .unread)
		#expect(model.articles(for: collection).map(\.id) == [newestUnread.id])
		#expect(model.allArticles(for: collection).map(\.id) == [newestUnread.id, olderRead.id])

		model.articleFilter = .unread
		#expect(model.articles(for: collection).map(\.id) == [newestUnread.id])
		#expect(model.allArticles(for: collection).map(\.id) == [newestUnread.id, olderRead.id])

		model.articleFilter = .read
		#expect(model.articles(for: collection).map(\.id) == [olderRead.id])

		model.articleFilter = .all
		#expect(model.articles(for: collection).map(\.id) == [newestUnread.id, olderRead.id])
	}

	@Test func articleFilterPreservesTheCachedSortOrder() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let collection = ReaderNavigationItem.smart(.forYou)
		let highRead = makeArticle(id: "high-read", isRead: true, receivedAt: 1_786_272_100, score: 90)
		let lowUnread = makeArticle(id: "low-unread", receivedAt: 1_786_272_200, score: 10)
		let highUnread = makeArticle(id: "high-unread", receivedAt: 1_786_272_000, score: 80)
		model.setArticles([lowUnread, highRead, highUnread], for: collection)
		model.setSortOrder(.score, for: collection)

		#expect(model.articles(for: collection).map(\.id) == [highUnread.id, lowUnread.id])

		model.articleFilter = .unread
		#expect(model.articles(for: collection).map(\.id) == [highUnread.id, lowUnread.id])
		model.articleFilter = .read
		#expect(model.articles(for: collection).map(\.id) == [highRead.id])
		model.articleFilter = .all
		#expect(model.articles(for: collection).map(\.id) == [highRead.id, highUnread.id, lowUnread.id])
	}

	@Test(arguments: [ReaderArticleFilter.unread, ReaderArticleFilter.read])
	func articleFilterDistinguishesFilteredAndGenuinelyEmptyCollections(filter: ReaderArticleFilter) throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let filteredCollection = ReaderNavigationItem.smart(.today)
		let article = makeArticle(id: "opposite-state", isRead: filter == .unread)
		model.setArticles([article], for: filteredCollection)
		model.setArticleFilter(filter, for: filteredCollection)

		#expect(model.articles(for: filteredCollection).isEmpty)
		#expect(model.isArticleFilterEmpty(for: filteredCollection))

		let genuinelyEmptyCollection = ReaderNavigationItem.smart(.starred)
		#expect(model.articles(for: genuinelyEmptyCollection).isEmpty)
		#expect(model.isArticleFilterEmpty(for: genuinelyEmptyCollection) == false)

		model.setArticleFilter(.all, for: filteredCollection)
		#expect(model.isArticleFilterEmpty(for: filteredCollection) == false)
	}

	@Test func articleFilterPreservesOpenDetailAndCacheWhenItsRowIsHidden() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let collection = ReaderNavigationItem.smart(.forYou)
		let unread = makeArticle(id: "selected-unread", receivedAt: 1_786_272_100)
		let read = makeArticle(id: "read", isRead: true, receivedAt: 1_786_272_000)
		model.setNavigation(ReaderNavigationState(items: [collection]))
		model.setSortOrder(.newest, for: collection)
		model.setArticles([unread, read], for: collection)
		model.select(item: collection)
		model.select(article: unread)

		model.articleFilter = .read

		#expect(model.selectedArticleID == unread.id)
		#expect(model.selectedArticle?.id == unread.id)
		#expect(model.preferredCompactColumn == .detail)
		#expect(model.allArticles(for: collection).map(\.id) == [unread.id, read.id])

		model.articleFilter = .all

		#expect(model.selectedArticleID == unread.id)
		#expect(model.selectedArticle?.id == unread.id)
		#expect(model.allArticles(for: collection).map(\.id) == [unread.id, read.id])
	}

	@Test func articleFilterDefaultsToUnreadAndStaysPerCollection() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let state = try makeNavigationState(unreadCount: 1)
		model.setNavigation(state)
		let folder = try #require(model.folderNavigationItems.first)
		let feed = try #require(model.feedNavigationItems(in: folder).first)
		let forYou = try #require(model.smartNavigationItems.first(where: { $0.smartSection == .forYou }))

		#expect(model.articleFilter == .unread)
		#expect(model.articleFilter(for: forYou) == .unread)
		#expect(model.articleFilter(for: folder) == .unread)
		#expect(model.articleFilter(for: feed) == .unread)

		model.select(item: feed)
		model.articleFilter = .all
		model.select(item: folder)
		model.articleFilter = .read
		model.select(item: forYou)

		#expect(model.articleFilter == .unread)
		#expect(model.articleFilter(for: feed) == .all)
		#expect(model.articleFilter(for: folder) == .read)
		#expect(model.articleFilter(for: forYou) == .unread)
	}

	@Test func articleFilterPersistsPerCollectionAcrossModelInstances() throws {
		let suiteName = "pigeon-article-filter-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let store = ReaderArticleFilterStore(defaults: defaults)
		let state = try makeNavigationState(unreadCount: 1)
		let firstModel = try makeModel(httpClient: MockHTTPClient(), articleFilterStore: store)
		firstModel.setNavigation(state)
		let folder = try #require(firstModel.folderNavigationItems.first)
		let feed = try #require(firstModel.feedNavigationItems(in: folder).first)
		let forYou = try #require(firstModel.smartNavigationItems.first(where: { $0.smartSection == .forYou }))

		firstModel.select(item: feed)
		firstModel.articleFilter = .all
		firstModel.articleFilter = .unread
		firstModel.select(item: folder)
		firstModel.articleFilter = .read

		let session = try #require(firstModel.session)
		let sessionKeyPrefix = ReaderArticleFilterStore.keyPrefix + session.articleFilterStorageIdentity + "."
		#expect(defaults.string(forKey: sessionKeyPrefix + feed.id) == "unread")
		#expect(defaults.string(forKey: sessionKeyPrefix + folder.id) == "read")
		#expect(defaults.string(forKey: sessionKeyPrefix + forYou.id) == nil)

		let restoredModel = try makeModel(httpClient: MockHTTPClient(), articleFilterStore: ReaderArticleFilterStore(defaults: defaults))
		restoredModel.setNavigation(state)
		let restoredFolder = try #require(restoredModel.folderNavigationItems.first)
		let restoredFeed = try #require(restoredModel.feedNavigationItems(in: restoredFolder).first)
		let restoredForYou = try #require(restoredModel.smartNavigationItems.first(where: { $0.smartSection == .forYou }))

		restoredModel.select(item: restoredFeed)
		#expect(restoredModel.articleFilter == .unread)
		restoredModel.select(item: restoredFolder)
		#expect(restoredModel.articleFilter == .read)
		restoredModel.select(item: restoredForYou)
		#expect(restoredModel.articleFilter == .unread)
		#expect(restoredModel.articleFilter(for: restoredFeed) == .unread)
		#expect(restoredModel.articleFilter(for: restoredFolder) == .read)
		#expect(restoredModel.articleFilter(for: restoredForYou) == .unread)
	}

	@Test func articleFilterRestoresAfterDisconnectAndReconnectToSameIdentity() async throws {
		let suiteName = "pigeon-article-filter-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let session = try makeSession(token: "same-session-token")
		let store = ReaderArticleFilterStore(defaults: defaults)
		let model = try makeModel(
			httpClient: MockHTTPClient(responseData: Data("Auth=pigeon/same-session-token".utf8)),
			articleFilterStore: store,
			session: session,
		)

		model.setArticleFilter(.all, for: .forYou)
		model.disconnect()
		#expect(model.articleFilter == .unread)

		model.password = "not-stored-password"
		await model.connect()

		#expect(model.session?.articleFilterStorageIdentity == session.articleFilterStorageIdentity)
		#expect(model.articleFilter == .all)
	}

	@Test func articleFilterCacheDoesNotBleedAcrossDisconnectAndSessionTransition() async throws {
		let suiteName = "pigeon-article-filter-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let firstSession = try makeSession(token: "first-session-token")
		let secondSession = try makeSession(token: "second-session-token")
		let store = ReaderArticleFilterStore(defaults: defaults)
		let model = try makeModel(
			httpClient: MockHTTPClient(responseData: Data("Auth=pigeon/second-session-token".utf8)),
			articleFilterStore: store,
			session: firstSession,
		)

		model.setArticleFilter(.all, for: .forYou)
		model.disconnect()
		#expect(model.articleFilter == .unread)

		model.password = "not-stored-password"
		await model.connect()

		#expect(model.session?.articleFilterStorageIdentity == secondSession.articleFilterStorageIdentity)
		#expect(model.articleFilter == .unread)
		model.articleFilter = .read
		#expect(store.filter(for: "forYou", session: firstSession) == .all)
		#expect(store.filter(for: "forYou", session: secondSession) == .read)
	}

	@Test func singleReadChangesMoveStoriesOutOfAndBackIntoTheActiveFilter() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let collection = ReaderNavigationItem.smart(.forYou, unreadCount: 1)
		let article = makeArticle(id: "selected")
		model.setNavigation(ReaderNavigationState(items: [collection]))
		model.setArticles([article], for: collection)
		model.select(item: collection)
		model.select(article: article)
		model.articleFilter = .unread

		let readMutation = Task { await model.setRead(article, read: true) }
		let readRequest = await controlled.nextRequest()
		#expect(model.articles(for: collection).isEmpty)
		#expect(model.selectedArticleID == article.id)
		#expect(model.selectedArticle?.isRead == true)
		#expect(model.allArticles(for: collection).first?.isRead == true)
		await controlled.resolve(readRequest)
		await readMutation.value

		let readArticle = try #require(model.allArticles(for: collection).first)
		let unreadMutation = Task { await model.setRead(readArticle, read: false) }
		let unreadRequest = await controlled.nextRequest()
		#expect(model.articles(for: collection).map(\.id) == [article.id])
		#expect(model.selectedArticleID == article.id)
		#expect(model.selectedArticle?.isRead == false)
		await controlled.resolve(unreadRequest)
		await unreadMutation.value
	}

	@Test func nextUnreadCrossesCollectionAndFeedBoundariesWithoutSelectingReadStories() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let current = makeArticle(id: "current", isRead: true, receivedAt: 300, feedKey: "one")
		let read = makeArticle(id: "read", isRead: true, receivedAt: 200, feedKey: "one")
		let next = makeArticle(id: "next", receivedAt: 100, feedKey: "two")
		model.setArticles([current, read], for: .forYou)
		model.setArticles([next], for: .unread)
		model.select(section: .forYou)
		model.select(article: current)

		let selected = model.selectNextUnread(after: current)

		#expect(selected?.id == next.id)
		#expect(model.selectedArticleID == next.id)
		#expect(model.selectedArticle?.feedKey == "two")
	}

	@Test func configurableReadBehaviorSupportsManualAndScrollThresholdModes() async throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let article = makeArticle(id: "reading-behavior")
		model.setArticles([article], for: .forYou)
		model.readerTypography.markReadBehavior = .manually

		await model.recordExplicitOpen(for: article)
		#expect(model.allArticles(for: .forYou).first?.isRead == false)

		model.readerTypography.markReadBehavior = .onScroll
		model.recordScrollDepth(itemId: article.id, depth: 0.59)
		await Task.yield()
		#expect(model.allArticles(for: .forYou).first?.isRead == false)
		model.recordScrollDepth(itemId: article.id, depth: 0.6)
		try await Task.sleep(for: .milliseconds(100))
		#expect(model.allArticles(for: .forYou).first?.isRead == true)
	}

	@Test func bulkReadUndoQueuesAReverseMutationAndRestoresEveryStory() async throws {
		let store = OfflineLibraryStore.inMemory()
		let model = try makeModel(httpClient: MockHTTPClient(statusCode: 500), offlineStore: store)
		let collection = ReaderNavigationItem.smart(.forYou, unreadCount: 2)
		let first = makeArticle(id: "first")
		let second = makeArticle(id: "second")
		model.setNavigation(ReaderNavigationState(items: [collection]))
		model.setArticles([first, second], for: collection)

		await model.markAllStoriesAsRead(in: collection)
		#expect(model.canUndoBulkRead)
		#expect(model.allArticles(for: collection).allSatisfy { $0.isRead })

		await model.undoLastBulkRead()
		#expect(model.canUndoBulkRead == false)
		#expect(model.allArticles(for: collection).allSatisfy { $0.isRead == false })
		let pending = try await store.pendingMutations(
			accountID: try #require(model.session).storageIdentity,
			limit: 100,
		)
		#expect(pending.count == 2)
		#expect(pending.last?.mutation.value == false)
	}

	@Test func filteredBulkReadMovesAboveAndBelowStoriesOutOfTheUnreadProjection() async throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let collection = ReaderNavigationItem.smart(.forYou, unreadCount: 3)
		model.setNavigation(ReaderNavigationState(items: [collection]))
		model.select(item: collection)
		model.setSortOrder(.newest, for: collection)
		let above = makeArticle(id: "above", receivedAt: 1_786_272_300)
		let boundary = makeArticle(id: "boundary", receivedAt: 1_786_272_200)
		let below = makeArticle(id: "below", receivedAt: 1_786_272_100)
		model.setArticles([below, boundary, above], for: collection)
		model.select(article: boundary)
		model.articleFilter = .unread

		await model.markStoriesAboveAsRead(boundary, in: collection)
		#expect(model.allArticles(for: collection).first(where: { $0.id == above.id })?.isRead == true)
		#expect(model.articles(for: collection).map(\.id) == [boundary.id, below.id])
		#expect(model.selectedArticleID == boundary.id)

		await model.markStoriesBelowAsRead(boundary, in: collection)
		#expect(model.allArticles(for: collection).first(where: { $0.id == below.id })?.isRead == true)
		#expect(model.articles(for: collection).map(\.id) == [boundary.id])
		#expect(model.selectedArticle?.id == boundary.id)
	}

	@Test func markAllQueuesBoundedBatchAndUpdatesEveryLoadedUnreadStory() async throws {
		let mock = MockHTTPClient()
		let model = try makeModel(httpClient: mock)
		let collection = ReaderNavigationItem.smart(.forYou, unreadCount: 3)
		let unreadOne = makeArticle(id: "unread-one")
		let unreadTwo = makeArticle(id: "unread-two")
		let alreadyRead = makeArticle(id: "already-read", isRead: true)
		model.setNavigation(ReaderNavigationState(items: [collection]))
		model.setArticles([unreadOne, alreadyRead, unreadTwo], for: collection)

		await model.markAllStoriesAsRead(in: collection)

		#expect(model.allArticles(for: collection).allSatisfy { $0.isRead })
		let request = try #require(await mock.lastRequest())
		let envelope = try JSONDecoder().decode(OfflineMutationEnvelope.self, from: try #require(request.body))
		#expect(envelope.mutations.count == 1)
		#expect(envelope.mutations.first?.scope == .all)
		#expect(Set(envelope.mutations.first?.itemIds ?? []) == Set([unreadOne.readerId, unreadTwo.readerId]))
	}

	@Test func filteredBulkReadStaysQueuedAndOptimisticWhenOffline() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let collection = ReaderNavigationItem.smart(.forYou, unreadCount: 2)
		model.setNavigation(ReaderNavigationState(items: [collection]))
		model.select(item: collection)
		let above = makeArticle(id: "above", receivedAt: 1_786_272_200)
		let boundary = makeArticle(id: "boundary", receivedAt: 1_786_272_100)
		model.setArticles([boundary, above], for: collection)
		model.select(article: boundary)
		model.articleFilter = .unread

		let mutation = Task { await model.markStoriesAboveAsRead(boundary, in: collection) }
		let request = await controlled.nextRequest()
		#expect(model.articles(for: collection).map(\.id) == [boundary.id])
		#expect(model.selectedArticleID == boundary.id)

		await controlled.resolve(request, statusCode: 500)
		await mutation.value

		#expect(model.allArticles(for: collection).first(where: { $0.id == above.id })?.isRead == true)
		#expect(model.articles(for: collection).map(\.id) == [boundary.id])
		#expect(model.selectedArticleID == boundary.id)
		#expect(model.selectedArticle?.id == boundary.id)
		#expect(model.offlineStorageStats.pendingMutationCount == 1)
	}

	@Test func sidebarFilterRestoresCollectionsAndKeepsUnreadSmartViewInternalOnly() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let workFolderID = "user/-/label/Work"
		let emptyFolderID = "user/-/label/Empty"
		let state = ReaderNavigationCatalog.make(
			subscriptions: [
				ReaderSubscription(id: "feed/1", title: "Unread folder feed", categories: [ReaderSubscriptionCategory(id: workFolderID, label: "Work")], url: "https://pigeon.test/feed/work-unread"),
				ReaderSubscription(id: "feed/2", title: "Read folder feed", categories: [ReaderSubscriptionCategory(id: workFolderID, label: "Work")], url: "https://pigeon.test/feed/work-read"),
				ReaderSubscription(id: "feed/3", title: "Empty folder feed", categories: [ReaderSubscriptionCategory(id: emptyFolderID, label: "Empty")], url: "https://pigeon.test/feed/empty"),
				ReaderSubscription(id: "feed/4", title: "Unread uncategorized feed", categories: [], url: "https://pigeon.test/feed/unread"),
				ReaderSubscription(id: "feed/5", title: "Read uncategorized feed", categories: [], url: "https://pigeon.test/feed/read"),
			],
			unreadCounts: [
				ReaderUnreadCount(id: "feed/1", count: 2),
				ReaderUnreadCount(id: "feed/2", count: 0),
				ReaderUnreadCount(id: "feed/3", count: 0),
				ReaderUnreadCount(id: "feed/4", count: 1),
				ReaderUnreadCount(id: "feed/5", count: 0),
				ReaderUnreadCount(id: workFolderID, count: 2),
				ReaderUnreadCount(id: emptyFolderID, count: 0),
			],
			smartCounts: ReaderNavigationSmartCounts(forYou: 0, today: 0, unread: 3, starred: 0),
		)
		model.setNavigation(state)

		let workFolder = try #require(model.folderNavigationItems.first(where: { $0.id == workFolderID }))
		#expect(model.smartNavigationItems.count == ReaderSection.allCases.count)
		#expect(model.smartNavigationItems.contains(where: { $0.smartSection == .unread }))
		#expect(model.visibleSmartNavigationItems.contains(where: { $0.smartSection == .unread }) == false)
		#expect(model.visibleFolderNavigationItems.map(\.id) == [emptyFolderID, workFolderID])
		#expect(model.visibleFeedNavigationItems(in: workFolder).map(\.title) == ["Read folder feed", "Unread folder feed"])
		#expect(model.visibleUncategorizedFeedNavigationItems.map(\.title) == ["Read uncategorized feed", "Unread uncategorized feed"])

		model.sidebarFilter = .unread
		#expect(model.visibleFolderNavigationItems.map(\.id) == [workFolderID])
		#expect(model.visibleFeedNavigationItems(in: workFolder).map(\.title) == ["Unread folder feed"])
		#expect(model.visibleUncategorizedFeedNavigationItems.map(\.title) == ["Unread uncategorized feed"])

		model.sidebarFilter = .all
		#expect(model.visibleFolderNavigationItems.map(\.id) == [emptyFolderID, workFolderID])
		#expect(model.visibleFeedNavigationItems(in: workFolder).map(\.title) == ["Read folder feed", "Unread folder feed"])
		#expect(model.visibleUncategorizedFeedNavigationItems.map(\.title) == ["Read uncategorized feed", "Unread uncategorized feed"])
	}

	@Test func markAboveUsesStrictBoundaryAndNewestDisplayedOrder() async throws {
		let mock = MockHTTPClient()
		let model = try makeModel(httpClient: mock)
		let collection = ReaderNavigationItem.smart(.unread, unreadCount: 3)
		model.setNavigation(ReaderNavigationState(items: [collection]))
		model.select(item: collection)
		model.setSortOrder(.newest, for: collection)

		let day = ReaderLocalDayBounds.localDay(containing: .now).start.addingTimeInterval(12 * 60 * 60)
		let alreadyRead = makeArticle(id: "already-read", isRead: true, receivedDate: day.addingTimeInterval(300))
		let unreadAbove = makeArticle(id: "unread-above", receivedDate: day.addingTimeInterval(200))
		let boundary = makeArticle(id: "boundary", receivedDate: day.addingTimeInterval(100))
		let below = makeArticle(id: "below", receivedDate: day)
		model.setArticles([below, boundary, unreadAbove, alreadyRead], for: collection)
		model.articleFilter = .all
		model.select(article: boundary)

		await model.markStoriesAboveAsRead(boundary, in: collection)

		#expect(model.articles(for: collection).map(\.id) == [alreadyRead.id, unreadAbove.id, boundary.id, below.id])
		#expect(model.articles(for: collection).first(where: { $0.id == alreadyRead.id })?.isRead == true)
		#expect(model.articles(for: collection).first(where: { $0.id == unreadAbove.id })?.isRead == true)
		#expect(model.articles(for: collection).first(where: { $0.id == boundary.id })?.isRead == false)
		#expect(model.articles(for: collection).first(where: { $0.id == below.id })?.isRead == false)
		#expect(editTagReaderIDs(from: await mock.requests()) == [unreadAbove.readerId])
		#expect(model.selectedArticleID == boundary.id)
		#expect(model.preferredCompactColumn == .detail)
	}

	@Test func markBelowUsesStrictBoundaryAndScoreDisplayedOrder() async throws {
		let mock = MockHTTPClient()
		let model = try makeModel(httpClient: mock)
		let collection = ReaderNavigationItem.smart(.forYou, unreadCount: 3)
		model.setNavigation(ReaderNavigationState(items: [collection]))
		model.select(item: collection)
		model.setSortOrder(.score, for: collection)

		let high = makeArticle(id: "high", score: 90)
		let boundary = makeArticle(id: "boundary", score: 50)
		let low = makeArticle(id: "low", score: 10)
		model.setArticles([low, boundary, high], for: collection)
		model.articleFilter = .all

		await model.markStoriesBelowAsRead(boundary, in: collection)

		#expect(model.articles(for: collection).map(\.id) == [high.id, boundary.id, low.id])
		#expect(model.articles(for: collection).first(where: { $0.id == high.id })?.isRead == false)
		#expect(model.articles(for: collection).first(where: { $0.id == boundary.id })?.isRead == false)
		#expect(model.articles(for: collection).first(where: { $0.id == low.id })?.isRead == true)
		#expect(editTagReaderIDs(from: await mock.requests()) == [low.readerId])
	}

	@Test(arguments: [ReaderNavigationKind.smart, ReaderNavigationKind.folder, ReaderNavigationKind.feed])
	func bulkReadSupportsSmartFolderAndFeedCollections(kind: ReaderNavigationKind) async throws {
		let mock = MockHTTPClient()
		let model = try makeModel(httpClient: mock)
		let state = try makeNavigationState(unreadCount: 2)
		model.setNavigation(state)
		let folder = try #require(model.folderNavigationItems.first)
		let feed = try #require(model.feedNavigationItems(in: folder).first)
		let currentCollection: ReaderNavigationItem
		switch kind {
		case .smart:
			currentCollection = try #require(model.smartNavigationItems.first(where: { $0.smartSection == .unread }))
		case .folder:
			currentCollection = folder
		case .feed:
			currentCollection = feed
		}
		model.select(item: currentCollection)
		model.setSortOrder(.newest, for: currentCollection)

		let day = ReaderLocalDayBounds.localDay(containing: .now).start.addingTimeInterval(12 * 60 * 60)
		let alreadyRead = makeArticle(id: "already-read", isRead: true, feedKey: "alpha", receivedDate: day.addingTimeInterval(300))
		var target = makeArticle(id: "target", feedKey: "alpha", receivedDate: day.addingTimeInterval(200))
		target.isStarred = true
		var boundary = makeArticle(id: "boundary", feedKey: "alpha", receivedDate: day.addingTimeInterval(100))
		boundary.isStarred = true
		let displayed = [alreadyRead, target, boundary]
		for item in state.items {
			model.setArticles(displayed, for: item)
		}
		model.articleFilter = .all
		model.select(article: boundary)

		await model.markStoriesAboveAsRead(boundary, in: currentCollection)

		#expect(editTagReaderIDs(from: await mock.requests()) == [target.readerId])
		for item in state.items {
			#expect(model.allArticles(for: item).first(where: { $0.id == target.id })?.isRead == true)
			#expect(model.allArticles(for: item).first(where: { $0.id == boundary.id })?.isRead == false)
			#expect(model.allArticles(for: item).first(where: { $0.id == alreadyRead.id })?.isRead == true)
		}
		#expect(model.navigation.items.allSatisfy { $0.unreadCount == 1 })
		#expect(model.selectedArticleID == boundary.id)
		#expect(model.preferredCompactColumn == .detail)
	}

	@Test func bulkReadUsesOneDurableBatchAndKeepsOptimisticStateOnFailure() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let state = try makeNavigationState(unreadCount: 2)
		model.setNavigation(state)
		let folder = try #require(model.folderNavigationItems.first)
		let feed = try #require(model.feedNavigationItems(in: folder).first)
		model.select(item: feed)
		model.setSortOrder(.newest, for: feed)

		let day = ReaderLocalDayBounds.localDay(containing: .now).start.addingTimeInterval(12 * 60 * 60)
		var first = makeArticle(id: "first", feedKey: "alpha", receivedDate: day.addingTimeInterval(200))
		first.isStarred = true
		var second = makeArticle(id: "second", feedKey: "alpha", receivedDate: day.addingTimeInterval(100))
		second.isStarred = true
		let boundary = makeArticle(id: "boundary", feedKey: "alpha", receivedDate: day)
		let displayed = [first, second, boundary]
		for item in state.items {
			model.setArticles(displayed, for: item)
		}
		model.articleFilter = .all
		model.select(article: boundary)

		let mutation = Task { await model.markStoriesAboveAsRead(boundary, in: feed) }
		let request = await controlled.nextRequest()
		#expect(model.navigation.items.allSatisfy { $0.unreadCount == 0 })
		for item in state.items {
			#expect(model.allArticles(for: item).first(where: { $0.id == first.id })?.isRead == true)
			#expect(model.allArticles(for: item).first(where: { $0.id == second.id })?.isRead == true)
			#expect(model.allArticles(for: item).first(where: { $0.id == boundary.id })?.isRead == false)
		}

		let envelope = try JSONDecoder().decode(
			OfflineMutationEnvelope.self,
			from: #require(request.request.httpBody),
		)
		#expect(envelope.mutations.count == 1)
		#expect(Set(envelope.mutations[0].itemIds) == Set([first.readerId, second.readerId]))
		await controlled.resolve(request, statusCode: 500)
		await mutation.value

		for item in state.items {
			#expect(model.allArticles(for: item).first(where: { $0.id == first.id })?.isRead == true)
			#expect(model.allArticles(for: item).first(where: { $0.id == second.id })?.isRead == true)
			#expect(model.allArticles(for: item).first(where: { $0.id == boundary.id })?.isRead == false)
		}
		#expect(model.navigation.items.allSatisfy { $0.unreadCount == 0 })
		#expect(model.selectedArticleID == boundary.id)
		#expect(model.preferredCompactColumn == .detail)
		#expect(model.offlineStorageStats.pendingMutationCount == 1)
		#expect(model.isOffline == false)
	}

	@Test func renamingAFeedUpdatesTheSidebarImmediatelyAndPersists() async throws {
		let store = OfflineLibraryStore.inMemory()
		let model = try makeModel(httpClient: MockHTTPClient(), offlineStore: store)
		let subscription = makeSubscription(id: "feed/1", key: "daily", title: "Daily", folder: nil)
		model.setSubscriptions([subscription])
		model.setNavigation(try makeUncategorizedFeedNavigation(subscription: subscription, unreadCount: 2))
		model.select(item: try #require(model.navigation.item(withID: subscription.id)))

		#expect(await model.renameFeed(subscription, to: "Morning Brief"))
		#expect(model.navigation.item(withID: subscription.id)?.title == "Morning Brief")
		#expect(model.selectedCollection.title == "Morning Brief")
		#expect(model.selectedCollection.id == subscription.id)

		let snapshot = try await store.loadSnapshot(accountID: try #require(model.session).storageIdentity)
		#expect(snapshot.subscriptions.first?.title == "Morning Brief")
		#expect(snapshot.navigation?.item(withID: subscription.id)?.title == "Morning Brief")
	}

	@Test func unsubscribingAFeedRemovesItFromTheSidebarAndPersists() async throws {
		let store = OfflineLibraryStore.inMemory()
		let model = try makeModel(httpClient: MockHTTPClient(), offlineStore: store)
		let daily = makeSubscription(id: "feed/1", key: "daily", title: "Daily", folder: nil)
		let weekly = makeSubscription(id: "feed/2", key: "weekly", title: "Weekly", folder: nil)
		model.setSubscriptions([daily, weekly])
		model.setNavigation(try makeUncategorizedFeedNavigation(subscriptions: [daily, weekly], unreadCount: 1))
		model.select(section: .forYou)

		#expect(await model.unsubscribe(daily))
		#expect(model.subscriptions.map(\.id) == ["feed/2"])
		#expect(model.navigation.item(withID: daily.id) == nil)
		#expect(model.navigation.item(withID: weekly.id)?.title == "Weekly")
		#expect(model.selectedNavigationID == ReaderSection.forYou.rawValue)

		let snapshot = try await store.loadSnapshot(accountID: try #require(model.session).storageIdentity)
		#expect(snapshot.subscriptions.map(\.id) == ["feed/2"])
		#expect(snapshot.navigation?.item(withID: daily.id) == nil)
		#expect(snapshot.navigation?.item(withID: weekly.id)?.title == "Weekly")
	}

	@Test func unsubscribingTheOpenFeedLeavesASmartViewInsteadOfAGhost() async throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let subscription = makeSubscription(id: "feed/1", key: "daily", title: "Daily", folder: "Design")
		let feedID = "feed/1::user/-/label/Design"
		model.setSubscriptions([subscription])
		model.setNavigation(try makeFolderFeedNavigation(subscription: subscription, unreadCount: 3))
		let feed = try #require(model.navigation.item(withID: feedID))
		model.setArticles([makeArticle(id: "open-feed-article", feedKey: "daily")], for: feed)
		model.select(item: feed)
		model.select(article: try #require(model.allArticles(for: feed).first))

		#expect(await model.unsubscribe(subscription))
		#expect(model.navigation.item(withID: feedID) == nil)
		#expect(model.navigation.item(withID: "user/-/label/Design") == nil)
		#expect(model.navigation.item(withID: subscription.id) == nil)
		#expect(model.selectedCollection.smartSection == .forYou)
		#expect(model.selectedArticleID == nil)
		#expect(model.allArticles(for: feed).isEmpty)
	}

	@Test func emptyFeedRenameIsRejectedBeforeQueueing() async throws {
		let store = OfflineLibraryStore.inMemory()
		let model = try makeModel(httpClient: MockHTTPClient(), offlineStore: store)
		let subscription = makeSubscription(id: "feed/1", key: "daily", title: "Daily", folder: nil)
		model.setSubscriptions([subscription])

		#expect(await model.renameFeed(subscription, to: "   ") == false)
		#expect(model.errorMessage == "Feed names must be between 1 and 200 characters.")
		#expect(model.subscriptions.first?.title == "Daily")
		let pending = try await store.pendingMutations(
			accountID: try #require(model.session).storageIdentity,
			limit: 100,
		)
		#expect(pending.isEmpty)
	}

	@Test func offlineFeedRenameStaysVisibleAndQueuedWhenRequestFails() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let subscription = makeSubscription(id: "feed/1", key: "daily", title: "Daily", folder: nil)
		model.setSubscriptions([subscription])

		let mutation = Task { await model.renameFeed(subscription, to: "Renamed") }
		let request = await controlled.nextRequest()
		#expect(model.subscriptions.first?.title == "Renamed")

		await controlled.resolve(request, statusCode: 500)
		let succeeded = await mutation.value

		#expect(succeeded)
		#expect(model.subscriptions.first?.title == "Renamed")
		#expect(model.offlineStorageStats.pendingMutationCount == 1)
		#expect(model.isOffline == false)
	}

	@Test func multiFolderFeedEditQueuesEveryFolderAndPersistsOptimisticSubscription() async throws {
		let controlled = ControlledHTTPClient()
		let store = OfflineLibraryStore.inMemory()
		let model = try makeModel(httpClient: controlled, offlineStore: store)
		let subscription = FeedSubscription(
			id: "feed/1",
			title: "Daily",
			categories: [
				FeedCategory(id: "user/-/label/Design", label: "Design"),
				FeedCategory(id: "user/-/label/Reading", label: "Reading"),
			],
			url: try #require(URL(string: "https://pigeon.test/feed/daily")),
			htmlUrl: nil,
			iconUrl: nil,
		)
		model.setSubscriptions([subscription])
		model.setNavigation(
			ReaderNavigationCatalog.make(
				subscriptions: [
					ReaderSubscription(
						id: subscription.id,
						title: subscription.title,
						categories: subscription.categories.map {
							ReaderSubscriptionCategory(id: $0.id, label: $0.label)
						},
						url: subscription.url.absoluteString,
					),
				],
				unreadCounts: [ReaderUnreadCount(id: subscription.id, count: 3)],
				smartCounts: ReaderNavigationSmartCounts(forYou: 3, today: 1, unread: 3, starred: 0),
			),
		)

		let edit = Task {
			await model.moveFeed(subscription, toFolderNames: ["Reading", "Research", "Reading"])
		}
		let request = await controlled.nextRequest()
		let envelope = try JSONDecoder().decode(
			OfflineMutationEnvelope.self,
			from: try #require(request.request.httpBody),
		)
		#expect(envelope.mutations.count == 1)
		#expect(envelope.mutations[0].kind == .moveFeed)
		#expect(envelope.mutations[0].feedId == subscription.id)
		#expect(envelope.mutations[0].folders == ["Reading", "Research"])
		#expect(model.subscriptions.first?.folderNames == ["Reading", "Research"])
		#expect(model.folderNavigationItems.map(\.title) == ["Reading", "Research"])

		let snapshot = try await store.loadSnapshot(accountID: try #require(model.session).storageIdentity)
		#expect(snapshot.subscriptions.first?.folderNames == ["Reading", "Research"])

		await controlled.resolve(request, statusCode: 500)
		#expect(await edit.value)
		let pending = try await store.pendingMutations(
			accountID: try #require(model.session).storageIdentity,
			limit: 100,
		)
		#expect(pending.map(\.mutation.folders) == [["Reading", "Research"]])
		#expect(model.subscriptions.first?.folderNames == ["Reading", "Research"])
		#expect(model.isOffline == false)
	}

	@Test func multiFolderFeedEditRejectsInvalidFolderNamesBeforeQueueing() async throws {
		let store = OfflineLibraryStore.inMemory()
		let model = try makeModel(httpClient: MockHTTPClient(), offlineStore: store)
		let subscription = makeSubscription(id: "feed/1", key: "daily", title: "Daily", folder: "Design")
		model.setSubscriptions([subscription])

		let succeeded = await model.moveFeed(subscription, toFolderNames: ["Research", " "])

		#expect(succeeded == false)
		#expect(model.errorMessage == "Folder names must be between 1 and 80 characters.")
		#expect(model.subscriptions.first?.folderNames == ["Design"])
		let pending = try await store.pendingMutations(
			accountID: try #require(model.session).storageIdentity,
			limit: 100,
		)
		#expect(pending.isEmpty)
	}

	@Test func olderLibraryLoadCannotReplaceNewerSubscriptions() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)

		let olderLoad = Task { await model.loadLibrary(force: true) }
		let olderRequest = await controlled.nextRequest()
		let newerLoad = Task { await model.loadLibrary(force: true) }
		let newerRequest = await controlled.nextRequest()

		await controlled.resolve(newerRequest, data: try subscriptionsData([
			makeSubscription(id: "feed/2", key: "newer", title: "Newer", folder: nil),
		]))
		await newerLoad.value
		await controlled.resolve(olderRequest, data: try subscriptionsData([
			makeSubscription(id: "feed/1", key: "older", title: "Older", folder: nil),
		]))
		await olderLoad.value

		#expect(model.subscriptions.map(\.title) == ["Newer"])
	}

	@Test func disconnectedLibraryLoadCannotRestoreThePreviousAccountsSubscriptions() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)

		let load = Task { await model.loadLibrary(force: true) }
		let request = await controlled.nextRequest()
		model.disconnect()
		await controlled.resolve(request, data: try subscriptionsData([
			makeSubscription(id: "feed/old", key: "old", title: "Old account", folder: nil),
		]))
		await load.value

		#expect(model.session == nil)
		#expect(model.subscriptions.isEmpty)
	}

	private func makeModel(
		httpClient: any HTTPClient,
		articleFilterStore: ReaderArticleFilterStore? = nil,
		session: PigeonSession? = nil,
		readerViewExtractor: (any ReaderViewExtracting)? = nil,
		offlineStore: (any OfflineLibraryStoring)? = nil,
	) throws -> ReaderAppModel {
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let storedSession = session ?? PigeonSession(baseURL: baseURL, token: "server-token")
		let isolatedDefaults = try #require(UserDefaults(suiteName: "pigeon-article-filter-\(UUID().uuidString)"))
		return ReaderAppModel(
			sessionStore: TestSessionStore(session: storedSession),
			httpClient: httpClient,
			readwiseTokenStore: TestReadwiseTokenStore(),
			articleFilterStore: articleFilterStore ?? ReaderArticleFilterStore(defaults: isolatedDefaults),
			offlineStore: offlineStore ?? OfflineLibraryStore.inMemory(),
			readerTypography: ReaderTypographySettings(defaults: isolatedDefaults),
			keyboardShortcuts: ReaderKeyboardShortcutSettings(defaults: isolatedDefaults),
			readerViewExtractor: readerViewExtractor,
		)
	}

	private func makeSession(token: String) throws -> PigeonSession {
		PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: token)
	}

	private func makeNavigationState(unreadCount: Int) throws -> ReaderNavigationState {
		ReaderNavigationCatalog.make(
			subscriptions: [
				ReaderSubscription(
					id: "feed/7",
					title: "Alpha",
					categories: [ReaderSubscriptionCategory(id: "user/-/label/Work", label: "Work")],
					url: "https://pigeon.test/feed/alpha",
				),
			],
			unreadCounts: [
				ReaderUnreadCount(id: "feed/7", count: unreadCount),
				ReaderUnreadCount(id: "user/-/label/Work", count: unreadCount),
				ReaderUnreadCount(id: "user/-/state/com.google/reading-list", count: unreadCount),
			],
			smartCounts: ReaderNavigationSmartCounts(
				forYou: unreadCount,
				today: unreadCount,
				unread: unreadCount,
				starred: unreadCount,
			),
		)
	}

	private func makeUncategorizedFeedNavigation(
		subscription: FeedSubscription,
		unreadCount: Int,
	) throws -> ReaderNavigationState {
		try makeUncategorizedFeedNavigation(subscriptions: [subscription], unreadCount: unreadCount)
	}

	private func makeUncategorizedFeedNavigation(
		subscriptions: [FeedSubscription],
		unreadCount: Int,
	) throws -> ReaderNavigationState {
		ReaderNavigationCatalog.make(
			subscriptions: subscriptions.map {
				ReaderSubscription(
					id: $0.id,
					title: $0.title,
					categories: $0.categories.map { ReaderSubscriptionCategory(id: $0.id, label: $0.label) },
					url: $0.url.absoluteString,
				)
			},
			unreadCounts: subscriptions.map { ReaderUnreadCount(id: $0.id, count: unreadCount) },
			smartCounts: ReaderNavigationSmartCounts(
				forYou: unreadCount,
				today: unreadCount,
				unread: unreadCount,
				starred: 0,
			),
		)
	}

	private func makeFolderFeedNavigation(
		subscription: FeedSubscription,
		unreadCount: Int,
	) throws -> ReaderNavigationState {
		ReaderNavigationCatalog.make(
			subscriptions: [
				ReaderSubscription(
					id: subscription.id,
					title: subscription.title,
					categories: subscription.categories.map { ReaderSubscriptionCategory(id: $0.id, label: $0.label) },
					url: subscription.url.absoluteString,
				),
			],
			unreadCounts: [
				ReaderUnreadCount(id: subscription.id, count: unreadCount),
				ReaderUnreadCount(id: "user/-/label/Design", count: unreadCount),
			],
			smartCounts: ReaderNavigationSmartCounts(
				forYou: unreadCount,
				today: unreadCount,
				unread: unreadCount,
				starred: 0,
			),
		)
	}

	private func makePaginationCollection() -> ReaderNavigationItem {
		ReaderNavigationItem(
			id: "user/-/label/News",
			title: "News",
			streamID: "user/-/label/News",
			kind: .folder,
			unreadCount: 3,
			parentID: nil,
			feedKey: nil,
			iconURL: nil,
			smartSection: nil,
		)
	}

	private func makeSubscription(id: String, key: String, title: String, folder: String?) -> FeedSubscription {
		guard let url = URL(string: "https://pigeon.test/feed/\(key)") else {
			preconditionFailure("Invalid test URL")
		}
		let categories = folder.map { [FeedCategory(id: "user/-/label/\($0)", label: $0)] } ?? []
		return FeedSubscription(id: id, title: title, categories: categories, url: url, htmlUrl: nil, iconUrl: nil)
	}

	private func makeArticle(
		id: String,
		isRead: Bool = false,
		receivedAt: TimeInterval = 1_786_272_000,
		score: Int = 50,
		feedKey: String = "daily",
		readerId: String? = nil,
		receivedDate: Date? = nil,
	) -> Recommendation {
		Recommendation(
			id: id,
			readerId: readerId ?? "tag:google.com,2005:reader/item/\(id)",
			feedKey: feedKey,
			source: "Daily",
			title: "Story \(id)",
			html: "<p>Body</p>",
			text: "Body",
			originalURL: nil,
			receivedAt: receivedDate ?? Date(timeIntervalSince1970: receivedAt),
			isRead: isRead,
			isStarred: false,
			score: score,
			confidence: 0,
			sampleCount: 0,
			explanation: "Starting with recency",
			learningState: "Starting with recency"
		)
	}

	private func editTagReaderIDs(from requests: [MockHTTPClient.RequestSnapshot]) -> [String] {
		requests
			.filter { $0.url.path == "/api/v1/mutations" }
			.compactMap(\.body)
			.compactMap { try? JSONDecoder().decode(OfflineMutationEnvelope.self, from: $0) }
			.flatMap { $0.mutations.flatMap(\.itemIds) }
	}

	private func responseData(items: [Recommendation]) throws -> Data {
		let response = RecommendationsResponse(
			generatedAt: Date(timeIntervalSince1970: 1_786_272_000),
			view: "for-you",
			items: items
		)
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .iso8601
		return try encoder.encode(response)
	}

	private func subscriptionsData(_ subscriptions: [FeedSubscription]) throws -> Data {
		try JSONEncoder().encode(SubscriptionListResponse(subscriptions: subscriptions))
	}

	private func streamIDsData(ids: [String], continuation: String?) -> Data {
		let itemRefs = ids.map { "{\"id\":\"\($0)\"}" }.joined(separator: ",")
		let continuationField = continuation.map { ",\"continuation\":\"\($0)\"" } ?? ""
		return Data("{\"itemRefs\":[\(itemRefs)]\(continuationField)}".utf8)
	}

	private func streamContentsData(ids: [String]) -> Data {
		let published = Int(Date.now.timeIntervalSince1970)
		let items = ids.map {
			"{\"id\":\"\($0)\",\"categories\":[],\"title\":\"\($0)\",\"published\":\(published),\"summary\":{\"content\":\"<p>Body</p>\"},\"content\":{\"content\":\"<p>Body</p>\"},\"alternate\":[],\"origin\":{\"streamId\":\"feed/7\",\"title\":\"Today\",\"htmlUrl\":\"https://example.com\"}}"
		}.joined(separator: ",")
		return Data("{\"id\":\"user/-/state/com.google/reading-list\",\"updated\":0,\"items\":[\(items)]}".utf8)
	}
}

private actor PausingOfflineLibraryStore: OfflineLibraryStoring {
	private let base = OfflineLibraryStore.inMemory()
	private var shouldPauseNextArticleSave = false
	private var articleSaveIsPaused = false
	private var pauseWaiters: [CheckedContinuation<Void, Never>] = []
	private var resumeContinuation: CheckedContinuation<Void, Never>?

	func pauseNextArticleSave() {
		shouldPauseNextArticleSave = true
	}

	func waitUntilArticleSaveIsPaused() async {
		if articleSaveIsPaused { return }
		await withCheckedContinuation { continuation in
			pauseWaiters.append(continuation)
		}
	}

	func resumeArticleSave() {
		resumeContinuation?.resume()
		resumeContinuation = nil
	}

	func loadSnapshot(accountID: String) async throws -> CachedLibrarySnapshot {
		try await base.loadSnapshot(accountID: accountID)
	}

	func saveNavigation(_ navigation: ReaderNavigationState, accountID: String) async throws {
		try await base.saveNavigation(navigation, accountID: accountID)
	}

	func saveSubscriptions(_ subscriptions: [FeedSubscription], accountID: String) async throws {
		try await base.saveSubscriptions(subscriptions, accountID: accountID)
	}

	func saveArticles(_ articles: [Recommendation], collectionID: String, accountID: String) async throws {
		if shouldPauseNextArticleSave {
			shouldPauseNextArticleSave = false
			articleSaveIsPaused = true
			let waiters = pauseWaiters
			pauseWaiters.removeAll()
			for waiter in waiters {
				waiter.resume()
			}
			await withCheckedContinuation { continuation in
				resumeContinuation = continuation
			}
			articleSaveIsPaused = false
		}
		try await base.saveArticles(articles, collectionID: collectionID, accountID: accountID)
	}

	func saveRestoration(_ restoration: ReaderRestorationState, accountID: String) async throws {
		try await base.saveRestoration(restoration, accountID: accountID)
	}

	func enqueue(_ mutation: OfflineMutation, accountID: String) async throws {
		try await base.enqueue(mutation, accountID: accountID)
	}

	func pendingMutations(accountID: String, limit: Int) async throws -> [PendingOfflineMutation] {
		try await base.pendingMutations(accountID: accountID, limit: limit)
	}

	func markMutationApplied(id: String, accountID: String) async throws {
		try await base.markMutationApplied(id: id, accountID: accountID)
	}

	func recordMutationFailure(id: String, message: String, accountID: String) async throws {
		try await base.recordMutationFailure(id: id, message: message, accountID: accountID)
	}

	func apply(_ page: IncrementalSyncPage, accountID: String) async throws {
		try await base.apply(page, accountID: accountID)
	}

	func storageStats(accountID: String) async throws -> OfflineStorageStats {
		try await base.storageStats(accountID: accountID)
	}

	func cleanupReadBodies(accountID: String, keepingNewest count: Int) async throws -> Int {
		try await base.cleanupReadBodies(accountID: accountID, keepingNewest: count)
	}

	func clearCachedArticles(accountID: String) async throws {
		try await base.clearCachedArticles(accountID: accountID)
	}

	func searchArticles(
		query: String,
		collectionID: String?,
		accountID: String,
		limit: Int,
	) async throws -> [Recommendation] {
		try await base.searchArticles(
			query: query,
			collectionID: collectionID,
			accountID: accountID,
			limit: limit,
		)
	}
}

@MainActor
private final class ScriptedReaderViewExtractor: ReaderViewExtracting {
	var urlError: Error?
	var htmlDocument: ReaderViewDocument?
	var htmlError: Error?
	private(set) var extractedHTML: String?

	init(urlError: Error? = nil, htmlDocument: ReaderViewDocument? = nil, htmlError: Error? = nil) {
		self.urlError = urlError
		self.htmlDocument = htmlDocument
		self.htmlError = htmlError
	}

	func extract(from url: URL) async throws -> ReaderViewDocument {
		if let urlError {
			throw urlError
		}
		return try ReaderViewDocument(contentHTML: "<p>From URL</p>")
	}

	func extract(html: String, title: String?, baseURL: URL?) async throws -> ReaderViewDocument {
		extractedHTML = html
		if let htmlError {
			throw htmlError
		}
		if let htmlDocument {
			return htmlDocument
		}
		throw ReaderViewError.extractionFailed
	}
}

private actor StartupHTTPClient: HTTPClient {
	private let subscriptionsData: Data
	private let recommendationsData: Data
	private let folderItemID: String?
	private var subscriptionRequestCount = 0
	private var folderPageRequests = 0

	init(subscriptionsData: Data, recommendationsData: Data, folderItemID: String? = nil) {
		self.subscriptionsData = subscriptionsData
		self.recommendationsData = recommendationsData
		self.folderItemID = folderItemID
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let url = request.url else {
			throw PigeonError.invalidServerURL
		}

		let data: Data
		let statusCode: Int
		switch url.path {
		case "/api/v1/sync":
			data = Data(#"{"cursor":"0","hasMore":false,"changes":[]}"#.utf8)
			statusCode = 200
		case "/reader/api/0/subscription/list":
			subscriptionRequestCount += 1
			data = subscriptionsData
			statusCode = subscriptionRequestCount == 1 ? 503 : 200
		case "/reader/api/0/unread-count":
			data = Data(#"{"unreadcounts":[]}"#.utf8)
			statusCode = 200
		case "/reader/api/0/stream/items/ids":
			let streamID = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "s" })?.value
			if streamID == "user/-/label/News", let folderItemID {
				folderPageRequests += 1
				data = Data("{\"itemRefs\":[{\"id\":\"\(folderItemID)\"}],\"continuation\":\"folder-next\"}".utf8)
			} else {
				data = Data(#"{"itemRefs":[]}"#.utf8)
			}
			statusCode = 200
		case "/reader/api/0/stream/items/contents":
			if let folderItemID {
				data = Data("{\"id\":\"user/-/label/News\",\"updated\":0,\"items\":[{\"id\":\"\(folderItemID)\",\"categories\":[],\"title\":\"Live folder\",\"published\":1786272000,\"summary\":{\"content\":\"<p>Body</p>\"},\"content\":{\"content\":\"<p>Body</p>\"},\"alternate\":[],\"origin\":{\"streamId\":\"feed/7\",\"title\":\"News\",\"htmlUrl\":\"https://example.com\"}}]}".utf8)
			} else {
				data = Data(#"{"items":[]}"#.utf8)
			}
			statusCode = 200
		case "/api/v1/recommendations":
			data = recommendationsData
			statusCode = 200
		default:
			data = Data("not found".utf8)
			statusCode = 404
		}

		guard let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil) else {
			throw PigeonError.invalidResponse
		}
		return (data, response)
	}

	func folderPageRequestCount() -> Int {
		folderPageRequests
	}
}

private actor PaginationHTTPClient: HTTPClient {
	struct RequestSnapshot: Sendable {
		let path: String
		let query: [String: String]
		let method: String?
		let body: Data?
	}

	private let repeatsContinuation: Bool
	private var capturedRequests: [RequestSnapshot] = []
	private var shouldFailNextItemIDRequest = false

	init(repeatsContinuation: Bool = false) {
		self.repeatsContinuation = repeatsContinuation
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let url = request.url else {
			throw PigeonError.invalidServerURL
		}
		let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
		let query = queryItems.reduce(into: [String: String]()) { result, item in
			if let value = item.value { result[item.name] = value }
		}
		capturedRequests.append(RequestSnapshot(path: url.path, query: query, method: request.httpMethod, body: request.httpBody))
		if url.path == "/reader/api/0/stream/items/ids", shouldFailNextItemIDRequest {
			shouldFailNextItemIDRequest = false
			throw URLError(.notConnectedToInternet)
		}

		let data: Data
		switch url.path {
		case "/reader/api/0/stream/items/ids":
			guard query["s"] == "user/-/label/News" else {
				data = Data(#"{"itemRefs":[]}"#.utf8)
				return (data, try Self.response(for: url, statusCode: 200))
			}
			switch query["c"] {
			case nil:
				data = Data(#"{"itemRefs":[{"id":"newest"},{"id":"middle"}],"continuation":"page-2"}"#.utf8)
			case "page-2":
				let continuation = repeatsContinuation ? ",\"continuation\":\"page-2\"" : ""
				data = Data("{\"itemRefs\":[{\"id\":\"older\"}]\(continuation)}".utf8)
			default:
				data = Data(#"{"itemRefs":[]}"#.utf8)
			}
		case "/reader/api/0/stream/items/contents":
			data = Self.contentsResponse(for: Self.formValues(from: request.httpBody, named: "i"))
		default:
			data = Data(#"{"error":"not found"}"#.utf8)
		}

		let statusCode = url.path == "/reader/api/0/stream/items/contents" || url.path == "/reader/api/0/stream/items/ids" ? 200 : 404
		return (data, try Self.response(for: url, statusCode: statusCode))
	}

	func requests() -> [RequestSnapshot] {
		capturedRequests
	}

	func failNextItemIDRequest() {
		shouldFailNextItemIDRequest = true
	}

	private static func contentsResponse(for ids: [String]) -> Data {
		let items = ids.map { id in
			let published: Int
			switch id {
			case "newest": published = 1_786_272_003
			case "middle": published = 1_786_272_002
			default: published = 1_786_272_001
			}
			return "{\"id\":\"\(id)\",\"categories\":[],\"title\":\"\(id.capitalized)\",\"published\":\(published),\"summary\":{\"content\":\"<p>Body</p>\"},\"content\":{\"content\":\"<p>Body</p>\"},\"alternate\":[],\"origin\":{\"streamId\":\"feed/7\",\"title\":\"News\",\"htmlUrl\":\"https://example.com\"}}"
		}.joined(separator: ",")
		return Data("{\"id\":\"user/-/label/News\",\"updated\":0,\"items\":[\(items)]}".utf8)
	}

	private static func formValues(from body: Data?, named name: String) -> [String] {
		let rawBody = String(decoding: body ?? Data(), as: UTF8.self)
		let queryItems = URLComponents(string: "https://pigeon.test/?\(rawBody)")?.queryItems ?? []
		return queryItems.filter { $0.name == name }.compactMap(\.value)
	}

	private static func response(for url: URL, statusCode: Int) throws -> HTTPURLResponse {
		guard let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil) else {
			throw PigeonError.invalidResponse
		}
		return response
	}
}
