import Foundation
import SwiftUI
import Testing
@testable import PigeonReader

@MainActor
struct ReaderAppModelTests {
	@Test func explicitOpenMarksUnreadStoryReadAndDoesNotRepeatDuringActiveMonitoring() async throws {
		let mock = MockHTTPClient()
		let model = try makeModel(httpClient: mock)
		let article = makeArticle(id: "item-1", isRead: false)
		model.articles = [article]

		await model.recordExplicitOpen(for: article)

		#expect(model.articles.first?.isRead == true)
		let requests = await mock.requests()
		#expect(requests.filter { $0.url.path == "/api/v1/engagement" }.count == 1)
		#expect(requests.filter { $0.url.path == "/reader/api/0/edit-tag" }.count == 1)
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

	@Test func optimisticReadRollsBackAcrossCachedSectionsWhenRequestFails() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let article = makeArticle(id: "shared", isRead: false)
		model.setArticles([article], for: .forYou)
		model.setArticles([article], for: .starred)

		let mutation = Task { await model.setRead(article, read: true) }
		let request = await controlled.nextRequest()

		#expect(model.articles(for: .forYou).first?.isRead == true)
		#expect(model.articles(for: .starred).first?.isRead == true)

		await controlled.resolve(request, statusCode: 500)
		await mutation.value

		#expect(model.articles(for: .forYou).first?.isRead == false)
		#expect(model.articles(for: .starred).first?.isRead == false)
		#expect(model.errorMessage != nil)
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

		#expect(model.articles(for: collection).map(\.id) == [newestUnread.id, olderRead.id])

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

		#expect(model.articles(for: collection).map(\.id) == [highRead.id, highUnread.id, lowUnread.id])

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
		model.articleFilter = filter

		#expect(model.articles(for: filteredCollection).isEmpty)
		#expect(model.isArticleFilterEmpty(for: filteredCollection))

		let genuinelyEmptyCollection = ReaderNavigationItem.smart(.starred)
		#expect(model.articles(for: genuinelyEmptyCollection).isEmpty)
		#expect(model.isArticleFilterEmpty(for: genuinelyEmptyCollection) == false)

		model.articleFilter = .all
		#expect(model.isArticleFilterEmpty(for: filteredCollection) == false)
	}

	@Test func articleFilterClearsHiddenDetailWithoutDiscardingSelectionOrCache() throws {
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

		#expect(model.selectedArticleID == nil)
		#expect(model.selectedArticle == nil)
		#expect(model.preferredCompactColumn == .content)
		#expect(model.allArticles(for: collection).map(\.id) == [unread.id, read.id])

		model.articleFilter = .all

		#expect(model.selectedArticleID == unread.id)
		#expect(model.selectedArticle?.id == unread.id)
		#expect(model.allArticles(for: collection).map(\.id) == [unread.id, read.id])
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
		#expect(model.selectedArticleID == nil)
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

	@Test func filteredBulkReadRollbackRestoresHiddenStoriesAndSelection() async throws {
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

		#expect(model.allArticles(for: collection).first(where: { $0.id == above.id })?.isRead == false)
		#expect(model.articles(for: collection).map(\.id) == [above.id, boundary.id])
		#expect(model.selectedArticleID == boundary.id)
		#expect(model.selectedArticle?.id == boundary.id)
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
		model.select(article: boundary)

		await model.markStoriesAboveAsRead(boundary, in: currentCollection)

		#expect(editTagReaderIDs(from: await mock.requests()) == [target.readerId])
		for item in state.items {
			#expect(model.articles(for: item).first(where: { $0.id == target.id })?.isRead == true)
			#expect(model.articles(for: item).first(where: { $0.id == boundary.id })?.isRead == false)
			#expect(model.articles(for: item).first(where: { $0.id == alreadyRead.id })?.isRead == true)
		}
		#expect(model.navigation.items.allSatisfy { $0.unreadCount == 1 })
		#expect(model.selectedArticleID == boundary.id)
		#expect(model.preferredCompactColumn == .detail)
	}

	@Test func partialBulkReadFailureKeepsSuccessAndRollsBackFailedStoryEverywhere() async throws {
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
		model.select(article: boundary)

		let mutation = Task { await model.markStoriesAboveAsRead(boundary, in: feed) }
		let firstRequest = await controlled.nextRequest()
		let secondRequest = await controlled.nextRequest()
		#expect(model.navigation.items.allSatisfy { $0.unreadCount == 0 })
		for item in state.items {
			#expect(model.articles(for: item).first(where: { $0.id == first.id })?.isRead == true)
			#expect(model.articles(for: item).first(where: { $0.id == second.id })?.isRead == true)
			#expect(model.articles(for: item).first(where: { $0.id == boundary.id })?.isRead == false)
		}

		let firstReaderID = try #require(readerID(from: firstRequest.request))
		let secondReaderID = try #require(readerID(from: secondRequest.request))
		#expect(Set([firstReaderID, secondReaderID]) == Set([first.readerId, second.readerId]))
		let successRequest = firstRequest
		let failedRequest = secondRequest
		let successID = firstReaderID == first.readerId ? first.id : second.id
		let failedID = firstReaderID == first.readerId ? second.id : first.id
		await controlled.resolve(successRequest)
		await controlled.resolve(failedRequest, statusCode: 500)
		await mutation.value

		for item in state.items {
			#expect(model.articles(for: item).first(where: { $0.id == successID })?.isRead == true)
			#expect(model.articles(for: item).first(where: { $0.id == failedID })?.isRead == false)
			#expect(model.articles(for: item).first(where: { $0.id == boundary.id })?.isRead == false)
		}
		#expect(model.navigation.items.allSatisfy { $0.unreadCount == 1 })
		#expect(model.selectedArticleID == boundary.id)
		#expect(model.preferredCompactColumn == .detail)
		#expect(model.errorMessage?.contains("Marked 1 of 2 stories as read") == true)
		#expect(model.errorMessage?.contains("Story \(failedID)") == true)
	}

	@Test func optimisticFeedRenameRollsBackWhenRequestFails() async throws {
		let controlled = ControlledHTTPClient()
		let model = try makeModel(httpClient: controlled)
		let subscription = makeSubscription(id: "feed/1", key: "daily", title: "Daily", folder: nil)
		model.setSubscriptions([subscription])

		let mutation = Task { await model.renameFeed(subscription, to: "Renamed") }
		let request = await controlled.nextRequest()
		#expect(model.subscriptions.first?.title == "Renamed")

		await controlled.resolve(request, statusCode: 500)
		let succeeded = await mutation.value

		#expect(succeeded == false)
		#expect(model.subscriptions.first?.title == "Daily")
		#expect(model.errorMessage != nil)
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

	private func makeModel(httpClient: any HTTPClient) throws -> ReaderAppModel {
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let session = PigeonSession(baseURL: baseURL, token: "server-token")
		return ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: httpClient,
			readwiseTokenStore: TestReadwiseTokenStore()
		)
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

	private func readerID(from request: URLRequest) -> String? {
		readerID(from: request.httpBody)
	}

	private func readerID(from body: Data?) -> String? {
		guard let body, let bodyString = String(data: body, encoding: .utf8),
			let components = URLComponents(string: "https://pigeon.test?\(bodyString)") else {
			return nil
		}
		return components.queryItems?.first(where: { $0.name == "i" })?.value
	}

	private func editTagReaderIDs(from requests: [MockHTTPClient.RequestSnapshot]) -> [String] {
		requests
			.filter { $0.url.path == "/reader/api/0/edit-tag" }
			.compactMap { readerID(from: $0.body) }
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
}
