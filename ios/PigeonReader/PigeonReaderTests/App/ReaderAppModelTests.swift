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

	@Test func folderAndFeedNavigationFilterUnreadWithoutAutoOpening() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let design = makeSubscription(id: "feed/1", key: "design", title: "Design Weekly", folder: "Design")
		let news = makeSubscription(id: "feed/2", key: "news", title: "Daily News", folder: "News")
		model.setSubscriptions([news, design])
		model.setArticles([
			makeArticle(id: "design-story", feedKey: "design"),
			makeArticle(id: "news-story", feedKey: "news"),
		], for: .unread)

		model.select(destination: .folder("Design"))

		#expect(model.articles.map(\.id) == ["design-story"])
		#expect(model.selectedArticleID == nil)
		#expect(model.preferredCompactColumn == .content)

		model.select(destination: .feed(news.id))
		#expect(model.articles.map(\.id) == ["news-story"])
		#expect(model.selectedArticleID == nil)
	}

	@Test func adjacentStoryNavigationStopsAtBoundaries() throws {
		let model = try makeModel(httpClient: MockHTTPClient())
		let first = makeArticle(id: "first")
		let second = makeArticle(id: "second")
		model.setArticles([first, second], for: .forYou)
		model.select(article: first)

		#expect(model.canSelectAdjacentArticle(offset: -1) == false)
		#expect(model.canSelectAdjacentArticle(offset: 1))
		model.selectAdjacentArticle(offset: 1)
		#expect(model.selectedArticleID == second.id)
		model.selectAdjacentArticle(offset: 1)
		#expect(model.selectedArticleID == second.id)
		model.selectAdjacentArticle(offset: -1)
		#expect(model.selectedArticleID == first.id)
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
		return ReaderAppModel(sessionStore: TestSessionStore(session: session), httpClient: httpClient)
	}

	private func makeArticle(id: String, isRead: Bool = false, feedKey: String = "daily") -> Recommendation {
		Recommendation(
			id: id,
			readerId: "tag:google.com,2005:reader/item/\(id)",
			feedKey: feedKey,
			source: "Daily",
			title: "Story \(id)",
			html: "<p>Body</p>",
			text: "Body",
			originalURL: nil,
			receivedAt: Date(timeIntervalSince1970: 1_786_272_000),
			isRead: isRead,
			isStarred: false,
			score: 50,
			confidence: 0,
			sampleCount: 0,
			explanation: "Starting with recency",
			learningState: "Starting with recency"
		)
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

	private func makeSubscription(id: String, key: String, title: String, folder: String?) -> FeedSubscription {
		guard let url = URL(string: "https://pigeon.test/feed/\(key)") else {
			preconditionFailure("Invalid test URL")
		}
		let categories = folder.map { [FeedCategory(id: "user/-/label/\($0)", label: $0)] } ?? []
		return FeedSubscription(id: id, title: title, categories: categories, url: url, htmlUrl: nil, iconUrl: nil)
	}

	private func subscriptionsData(_ subscriptions: [FeedSubscription]) throws -> Data {
		try JSONEncoder().encode(SubscriptionListResponse(subscriptions: subscriptions))
	}
}
