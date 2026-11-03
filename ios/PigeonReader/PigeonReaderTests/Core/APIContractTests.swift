import Foundation
import Testing
@testable import PigeonReader

/// Decodes the Worker's API contract fixtures (`test/fixtures/api-contract`) through the
/// production `PigeonAPIClient`, so a response the Worker produces that this app cannot
/// read fails here. The Worker side (`test/api-contract.test.ts`) proves the Worker still
/// produces exactly these fixtures. Changing a fixture is an API change: see its README.
struct APIContractTests {
	private static let baseURL = URL(string: "https://pigeon.example")!

	// MARK: - Authentication and sync

	@Test func clientLoginFixtureYieldsASession() async throws {
		let body = try Self.fixture("client-login.response.txt")
		let session = try await PigeonAPIClient.authenticate(
			baseURL: Self.baseURL,
			password: "contract-password",
			httpClient: MockHTTPClient(responseData: body),
		)
		#expect(session.token.count == 64)
		#expect(String(decoding: body, as: UTF8.self).hasSuffix("Auth=pigeon/\(session.token)"))
	}

	@Test func syncFixtureDecodesEveryEntityKind() async throws {
		let page = try await Self.client("sync.response.json").incrementalSync(cursor: nil)

		#expect(page.cursor == "v1:16")
		#expect(page.hasMore == false)
		#expect(Set(page.changes.map(\.entityType)) == [.feed, .article, .status])
		let feed = try #require(page.changes.first { $0.entityType == .feed && $0.entityId == "design-weekly" }?.payload)
		#expect(feed.streamId == "feed/1")
		#expect(feed.feedURL?.absoluteString == "https://feeds.example.com/design.xml")
		#expect(feed.folders == ["Design"])
		#expect(feed.isActive == true)
		let article = try #require(page.changes.first { $0.entityId == "0b3c7a52-5d1e-4f8e-9a51-1f2d3c4b5a61" && $0.entityType == .article })
		#expect(article.changedAt == Self.date("2026-11-01T11:00:00Z"))
		#expect(article.payload?.readerId == "tag:google.com,2005:reader/item/0000000000000001")
		#expect(article.payload?.author == "Ada Lovelace")
		#expect(article.payload?.receivedAt == Self.date("2026-11-01T09:00:00Z"))
		#expect(article.payload?.originalURL?.host() == "example.com")
		let paywalled = try #require(page.changes.first { $0.payload?.isPaywalled == true }?.payload)
		#expect(paywalled.feedKey == "morning-brief")
		#expect(page.changes.contains { $0.payload?.isBodyPruned == true })
		let status = try #require(page.changes.first { $0.entityType == .status }?.payload)
		#expect(status.version == 1)
		#expect(status.updatedAt == Self.date("2026-11-01T11:00:00Z"))
		let deletion = try #require(page.changes.first { $0.operation == .delete })
		#expect(deletion.entityType == .article)
		#expect(deletion.payload == nil)
	}

	// MARK: - Mutations and engagement

	@Test func mutationRequestAndResponsesMatchTheContract() async throws {
		let mock = MockHTTPClient(responseData: try Self.fixture("mutations.response.json"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: Self.baseURL, token: "token"), httpClient: mock)
		let firstItem = "tag:google.com,2005:reader/item/0000000000000001"
		let thirdItem = "tag:google.com,2005:reader/item/0000000000000003"
		let mutations = [
			OfflineMutation(id: "8f0e1b2c-0001-4a00-8000-000000000001", kind: .setRead, itemIds: [firstItem], value: true),
			OfflineMutation(id: "8f0e1b2c-0002-4a00-8000-000000000002", kind: .setStarred, itemIds: [firstItem], value: true),
			OfflineMutation(id: "8f0e1b2c-0003-4a00-8000-000000000003", kind: .setReadBatch, itemIds: [thirdItem], value: true, scope: .above),
			OfflineMutation(id: "8f0e1b2c-0004-4a00-8000-000000000004", kind: .feedback, itemIds: [thirdItem], feedback: "more_like_this"),
			OfflineMutation(id: "8f0e1b2c-0005-4a00-8000-000000000005", kind: .renameFeed, feedId: "feed/1", title: "Design Weekly Digest"),
			OfflineMutation(id: "8f0e1b2c-0006-4a00-8000-000000000006", kind: .moveFeed, feedId: "feed/2", folders: ["News"]),
			OfflineMutation(id: "8f0e1b2c-0007-4a00-8000-000000000007", kind: .unsubscribeFeed, feedId: "feed/3"),
		]

		let applied = try await client.sendMutations(mutations)

		let request = try #require(await mock.lastRequest())
		#expect(request.url.path() == "/api/v1/mutations")
		try Self.expectJSON(try #require(request.body), equalsFixture: "mutations.request.json")
		#expect(applied.results.map(\.mutationId) == mutations.map(\.id))
		#expect(applied.results.allSatisfy { $0.status == .applied && $0.error == nil })
		#expect(applied.results.first?.appliedAt == Self.date("2026-11-01T12:00:00Z"))

		let replayed = try await Self.client("mutations-replay.response.json").sendMutations(mutations)
		#expect(replayed.results.allSatisfy { $0.status == .alreadyApplied })
		#expect(replayed.results.first?.appliedAt == Self.date("2026-11-01T12:00:00Z"))
	}

	@Test func syncAfterMutationsCarriesTheirEffects() async throws {
		let page = try await Self.client("sync-after-mutations.response.json").incrementalSync(cursor: nil)

		let status = try #require(page.changes.last { $0.entityType == .status && $0.entityId == "0b3c7a52-5d1e-4f8e-9a51-1f2d3c4b5a61" }?.payload)
		#expect(status.isRead == true)
		#expect(status.isStarred == true)
		#expect(status.mutationId == "8f0e1b2c-0002-4a00-8000-000000000002")
		#expect(status.updatedAt == Self.date("2026-11-01T12:00:00Z"))
		let feeds = page.changes.filter { $0.entityType == .feed }.compactMap(\.payload)
		#expect(feeds.last { $0.feedKey == "design-weekly" }?.title == "Design Weekly Digest")
		#expect(feeds.last { $0.feedKey == "morning-brief" }?.folders == ["News"])
		#expect(feeds.last { $0.feedKey == "quiet-blog" }?.isActive == false)
	}

	@Test func engagementRequestMatchesTheContract() async throws {
		let mock = MockHTTPClient(responseData: Data(#"{"accepted":5}"#.utf8))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: Self.baseURL, token: "token"), httpClient: mock)
		let firstItem = "tag:google.com,2005:reader/item/0000000000000001"

		try await client.sendEngagement([
			EngagementEvent(id: "5a1d0c3e-0001-4b00-9000-000000000001", itemId: firstItem, type: .explicitOpen, occurredAt: Self.date("2026-11-01T10:00:00Z")),
			EngagementEvent(id: "5a1d0c3e-0002-4b00-9000-000000000002", itemId: firstItem, type: .activeReading, durationSeconds: 95, occurredAt: Self.date("2026-11-01T10:02:00Z")),
			EngagementEvent(id: "5a1d0c3e-0003-4b00-9000-000000000003", itemId: firstItem, type: .scrollDepth, scrollDepth: 0.75, occurredAt: Self.date("2026-11-01T10:03:00Z")),
			EngagementEvent(
				id: "5a1d0c3e-0004-4b00-9000-000000000004",
				itemId: "tag:google.com,2005:reader/item/0000000000000002",
				type: .outboundLink,
				destinationHost: "example.com",
				occurredAt: Self.date("2026-11-01T10:05:00Z"),
			),
			EngagementEvent(
				id: "5a1d0c3e-0005-4b00-9000-000000000005",
				itemId: "tag:google.com,2005:reader/item/0000000000000003",
				type: .notInterested,
				occurredAt: Self.date("2026-11-01T10:06:00Z"),
			),
		])

		let request = try #require(await mock.lastRequest())
		#expect(request.url.path() == "/api/v1/engagement")
		try Self.expectJSON(try #require(request.body), equalsFixture: "engagement.request.json")
	}

	// MARK: - Personalization and settings

	@Test func personalizationFixturesDecode() async throws {
		let snapshot = try await Self.client("personalization.response.json").personalization()
		#expect(snapshot.exportedAt == Self.date("2026-11-01T12:00:00Z"))
		#expect(snapshot.monitoredTopics == ["typography"])
		#expect(snapshot.policy.confirmedSignals.isEmpty == false)
		#expect(snapshot.history.count == 5)
		#expect(snapshot.history.first?.type == "not_interested")
		#expect(snapshot.history.first?.occurredAt == Self.date("2026-11-01T10:06:00Z"))
		#expect(snapshot.history.first?.source == "Morning Brief")

		let updated = try await Self.client("personalization-update.response.json")
			.updatePersonalization(monitoredTopics: ["Typography", "Climate policy"])
		#expect(updated.monitoredTopics == ["Typography", "Climate policy"])
	}

	@Test func readwiseTokenFixtureDecodes() async throws {
		#expect(try await Self.client("readwise-token.response.json").readwiseToken() == "readwise-contract-token")
	}

	@Test func serverStatusFixtureDecodesSyncHealth() async throws {
		let health = try await Self.client("app-status.response.json").syncHealth()
		#expect(health.generatedAt == Self.date("2026-11-01T12:00:00Z"))
		#expect(health.backedOffCount == 1)
		#expect(health.healthyCount == 1)
		let failing = try #require(health.feeds.first)
		#expect(failing.feedKey == "quiet-blog")
		#expect(failing.state == "backing_off")
		#expect(failing.retryAt == Self.date("2026-11-01T14:00:00Z"))
		#expect(failing.canRetry == false)
		#expect(health.recentActivity.map(\.outcome) == ["success", "http_error"])
		#expect(health.recentActivity.last?.errorCode == "http_503")
	}

	@Test func staleFeedsFixtureDecodes() async throws {
		let snapshot = try await Self.client("stale-feeds.response.json").staleFeeds(days: 90)
		#expect(snapshot.cutoff == Self.date("2026-08-03T12:00:00Z"))
		let feed = try #require(snapshot.feeds.first)
		#expect(feed.streamId == "feed/3")
		#expect(feed.lastArticleAt == Self.date("2025-01-15T00:00:00Z"))
		#expect(feed.httpStatus == 503)
		#expect(feed.archived == false)
	}

	// MARK: - Google Reader endpoints

	@Test func subscriptionListFixtureDecodesForSidebarAndLibrary() async throws {
		let client = try Self.client("subscription-list.response.json")

		let sidebar = try await client.readerSubscriptions()
		#expect(sidebar.map(\.id) == ["feed/1", "feed/2", "feed/3"])
		#expect(sidebar.first?.categories.map(\.label) == ["Design"])
		#expect(sidebar.first?.iconURL == "https://example.com/icon.png")

		let library = try await client.subscriptions()
		#expect(library.map(\.feedKey) == ["design-weekly", "morning-brief", "quiet-blog"])
		#expect(library.first?.folderNames == ["Design"])
		#expect(library[1].sourceUrl == nil)
	}

	@Test func unreadCountFixtureDecodes() async throws {
		let counts = try await Self.client("unread-count.response.json").readerUnreadCounts()
		let byID = Dictionary(uniqueKeysWithValues: counts.map { ($0.id, $0.count) })
		#expect(byID["feed/1"] == 1)
		#expect(byID["feed/2"] == 1)
		#expect(byID["user/-/label/Design"] == 1)
		#expect(byID["user/-/state/com.google/reading-list"] == 2)
	}

	@Test func streamItemIDsFixtureDecodesPigeonExtensions() async throws {
		let page = try await Self.client("stream-item-ids.response.json")
			.streamItemIDs(streamID: "user/-/state/com.google/reading-list", limit: 2)
		#expect(page.itemRefs.map(\.id) == ["1", "3"])
		#expect(page.itemRefs.first?.contentVersion == "2")
		#expect(page.itemRefs.first?.read == false)
		#expect(page.continuation?.isEmpty == false)
	}

	@Test func streamFixturesLoadAReaderPageThroughIDsAndContents() async throws {
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: Self.baseURL, token: "token"),
			httpClient: try ContractFixtureHTTPClient(routes: [
				"/reader/api/0/stream/items/ids": "stream-item-ids.response.json",
				"/reader/api/0/stream/items/contents": "stream-item-contents.response.json",
			]),
		)

		let page = try await client.recommendationsPage(from: "user/-/state/com.google/reading-list")

		#expect(page.items.map(\.readerId) == [
			"tag:google.com,2005:reader/item/0000000000000001",
			"tag:google.com,2005:reader/item/0000000000000003",
		])
		let first = try #require(page.items.first)
		#expect(first.source == "Design Weekly")
		#expect(first.feedKey == "feed/1")
		#expect(first.author == "Ada Lovelace")
		#expect(first.html.contains("Typography decides"))
		#expect(first.contentVersion == "2")
		#expect(first.receivedAt == Self.date("2026-11-01T09:00:00Z"))
		#expect(first.safeOriginalURL?.absoluteString == "https://example.com/durable-reader")
		#expect(page.items.last?.isPaywalled == true)
		#expect(page.continuation?.isEmpty == false)
	}

	@Test func streamContentsFixtureDecodesReadStarredAndPrunedItems() throws {
		let decoded = try JSONDecoder().decode(ReaderStreamContentsResponse.self, from: try Self.fixture("stream-item-contents.response.json"))
		let byID = Dictionary(uniqueKeysWithValues: decoded.items.map { (ReaderArticleIdentity.normalized($0.id), $0) })
		let starred = try #require(byID["2"])
		#expect(starred.isRead && starred.isStarred)
		#expect(starred.author == nil)
		#expect(byID["4"]?.isBodyPruned == true)
		#expect(byID["3"]?.alternate.isEmpty == true)
	}

	@Test func quickAddFixtureDecodes() async throws {
		let added = try await Self.client("quickadd.response.json")
			.addSubscription(url: try #require(URL(string: "https://notes.example.net/feed.xml")))
		#expect(added.streamId == "feed/4")
		#expect(added.streamName == "Field Notes")
		#expect(added.isNew == true)
	}

	// MARK: - Recommendations

	@Test func forYouFixtureDecodes() async throws {
		let items = try await Self.client("recommendations-for-you.response.json").recommendations(for: .forYou)
		let item = try #require(items.first)
		#expect(items.count == 1)
		#expect(item.readerId == "tag:google.com,2005:reader/item/0000000000000001")
		#expect(item.score == 89)
		#expect(item.sampleCount == 1)
		#expect(item.receivedAt == Self.date("2026-11-01T09:00:00Z"))
		#expect(item.isBodyPruned == false)
		#expect(item.html.contains("Typography decides"))
	}

	@Test func unreadRecommendationsFixtureDecodes() async throws {
		let items = try await Self.client("recommendations-unread.response.json").recommendations(for: .unread)
		#expect(items.map(\.feedKey) == ["design-weekly", "morning-brief"])
		#expect(items.last?.isPaywalled == true)
		#expect(items.last?.originalURL == nil)
	}

	// MARK: - Helpers

	private static func client(_ fixture: String) throws -> PigeonAPIClient {
		PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "token"),
			httpClient: MockHTTPClient(responseData: try Self.fixture(fixture)),
		)
	}

	nonisolated static func fixture(_ name: String) throws -> Data {
		let bundle = Bundle(for: APIContractBundleToken.self)
		let url = try #require(
			bundle.url(forResource: name, withExtension: nil, subdirectory: "api-contract"),
			"Missing contract fixture \(name); is test/fixtures/api-contract a PigeonReaderTests resource?",
		)
		return try Data(contentsOf: url)
	}

	private static func date(_ value: String) -> Date {
		guard let date = ISO8601DateFormatter().date(from: value) else {
			fatalError("Invalid fixture date \(value)")
		}
		return date
	}

	/// Compares JSON values, ignoring key order and whitespace.
	private static func expectJSON(_ body: Data, equalsFixture name: String) throws {
		let actual = try JSONSerialization.jsonObject(with: body) as? NSDictionary
		let expected = try JSONSerialization.jsonObject(with: try fixture(name)) as? NSDictionary
		#expect(actual != nil && actual == expected, "App request no longer matches \(name): \(String(decoding: body, as: UTF8.self))")
	}
}

private nonisolated final class APIContractBundleToken {}

/// Serves contract fixtures by request path, for client calls that span endpoints.
private actor ContractFixtureHTTPClient: HTTPClient {
	private let responses: [String: Data]

	init(routes: [String: String]) throws {
		responses = try routes.mapValues { try APIContractTests.fixture($0) }
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let url = request.url, let data = responses[url.path()],
			let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
			throw PigeonError.invalidResponse
		}
		return (data, response)
	}
}
