import Foundation
import Testing
@testable import PigeonReader

struct PigeonAPIClientTests {
	@Test func clientLoginBuildsFormRequestAndReturnsOnlyTokenAndURL() async throws {
		let response = Data("SID=pigeon/server-token\nLSID=null\nAuth=pigeon/server-token".utf8)
		let mock = MockHTTPClient(responseData: response)
		let baseURL = try #require(URL(string: "https://pigeon.test/"))

		let session = try await PigeonAPIClient.authenticate(
			baseURL: baseURL,
			password: "not-stored-password",
			httpClient: mock,
		)

		#expect(session.token == "server-token")
		#expect(session.baseURL.absoluteString == "https://pigeon.test")
		let request = try #require(await mock.lastRequest())
		#expect(request.url.path == "/accounts/ClientLogin")
		#expect(request.method == "POST")
		let body = String(decoding: request.body ?? Data(), as: UTF8.self)
		#expect(body.contains("Passwd=not-stored-password"))
		#expect(session.token.localizedCaseInsensitiveContains("password") == false)
	}

	@Test func recommendationsDecodeScoresAndUseReaderAuthorization() async throws {
		let response = Data(
			"""
			{"generatedAt":"2026-08-09T12:00:00Z","view":"for-you","items":[{"id":"item-1","readerId":"tag:google.com,2005:reader/item/0000000000000001","feedKey":"daily","source":"Daily","title":"A useful story","html":"<p>Hello</p>","text":"Hello","originalURL":"https://example.com/story","receivedAt":"2026-08-09T11:00:00Z","isRead":false,"isStarred":false,"score":82,"confidence":0.6,"sampleCount":6,"explanation":"This source matches what you have been reading and saving.","learningState":"Personalized from 6 signals"}]}
			""".utf8,
		)
		let mock = MockHTTPClient(responseData: response)
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)

		let items = try await client.recommendations(for: .forYou)

		let item = try #require(items.first)
		#expect(item.score == 82)
		#expect(item.confidence == 0.6)
		#expect(item.safeOriginalURL?.scheme == "https")
		let request = try #require(await mock.lastRequest())
		#expect(request.url.path == "/api/v1/recommendations")
		#expect(request.url.query?.contains("view=for-you") == true)
		#expect(request.authorization == "GoogleLogin auth=pigeon/server-token")
	}

#if DEBUG
	@Test func previewRecommendationsRefreshRetainsSeededArticles() async throws {
		let seededArticles = Array(PreviewData.articles.prefix(2))
		let baseURL = try #require(URL(string: "https://pigeon.preview"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "preview-token"),
			httpClient: PreviewHTTPClient(recommendations: seededArticles),
		)

		let refreshedArticles = try await client.recommendations(for: .forYou)

		#expect(refreshedArticles == seededArticles)
	}
#endif

	@Test func incrementalSyncSendsOpaqueCursorAndDecodesCanonicalDates() async throws {
		let response = Data(
			#"{"cursor":"v1:42","hasMore":false,"changes":[{"sequence":42,"entityType":"status","entityId":"item-1","operation":"upsert","changedAt":"2026-08-15T12:00:00.000Z","payload":{"itemId":"item-1","isRead":true,"isStarred":false,"updatedAt":"2026-08-15T12:00:00.000Z","version":2,"mutationId":"mutation-1"}}]}"#.utf8,
		)
		let mock = MockHTTPClient(responseData: response)
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)

		let page = try await client.incrementalSync(cursor: "v1:41", limit: 999)

		#expect(page.cursor == "v1:42")
		#expect(page.changes.first?.payload?.mutationId == "mutation-1")
		let request = try #require(await mock.lastRequest())
		let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
		#expect(request.url.path == "/api/v1/sync")
		#expect(query.first(where: { $0.name == "cursor" })?.value == "v1:41")
		#expect(query.first(where: { $0.name == "limit" })?.value == "200")
	}

	@Test func mutationBatchUsesStableIdsAndDecodesAlreadyAppliedReceipts() async throws {
		let response = Data(
			#"{"results":[{"mutationId":"mutation-1","status":"already_applied","appliedAt":"2026-08-15T12:00:00.000Z","error":null}]}"#.utf8,
		)
		let mock = MockHTTPClient(responseData: response)
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)
		let mutation = OfflineMutation(
			id: "mutation-1",
			kind: .setRead,
			itemIds: ["reader-1"],
			value: true,
			scope: .single,
		)

		let result = try await client.sendMutations([mutation])

		#expect(result.results.first?.status == .alreadyApplied)
		let request = try #require(await mock.lastRequest())
		#expect(request.url.path == "/api/v1/mutations")
		#expect(request.method == "POST")
		#expect(request.contentType == "application/json; charset=utf-8")
		let envelope = try JSONDecoder().decode(OfflineMutationEnvelope.self, from: try #require(request.body))
		#expect(envelope.mutations == [mutation])
	}

	@Test func streamRecommendationsIncludeTheOriginSourceInTheirExplanation() async throws {
		let mock = SingleStreamHTTPClient()
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)

		let items = try await client.recommendations(from: "feed/7")

		#expect(items.first?.explanation == "From Daily")
		#expect(items.first?.author == "Alice Appleseed")
		#expect(items.first?.displayAuthor == "Alice Appleseed")
	}

	@Test func streamRecommendationsTreatABlankAuthorAsMissing() async throws {
		let mock = BlankAuthorStreamHTTPClient()
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)

		let items = try await client.recommendations(from: "feed/7")

		#expect(items.first?.author == nil)
		#expect(items.first?.displayAuthor == nil)
		#expect(items.first?.source == "Daily")
	}

	@Test func clientLoginPreservesAnOptionalServerPath() async throws {
		let mock = MockHTTPClient(responseData: Data("Auth=pigeon/server-token".utf8))
		let baseURL = try #require(URL(string: "https://pigeon.test/reader/"))

		let session = try await PigeonAPIClient.authenticate(
			baseURL: baseURL,
			password: "password",
			httpClient: mock,
		)

		#expect(session.baseURL.absoluteString == "https://pigeon.test/reader")
		let request = try #require(await mock.lastRequest())
		#expect(request.url.path == "/reader/accounts/ClientLogin")
	}

	@Test func clientLoginRejectsUnencryptedCredentialURLsBeforeNetworking() async throws {
		let mock = MockHTTPClient(responseData: Data("Auth=pigeon/server-token".utf8))
		let baseURL = try #require(URL(string: "http://pigeon.test"))

		do {
			_ = try await PigeonAPIClient.authenticate(baseURL: baseURL, password: "password", httpClient: mock)
			Issue.record("Expected HTTP authentication to be rejected.")
		} catch PigeonError.invalidServerURL {
			#expect(await mock.lastRequest() == nil)
		} catch {
			Issue.record("Unexpected error: \(error)")
		}
	}

	@Test func outboundEngagementSendsOnlyTheNormalizedDestinationHost() async throws {
		let mock = MockHTTPClient()
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)

		try await client.sendEngagement([
			EngagementEvent(itemId: "item-1", type: .outboundLink, destinationHost: "news.example.com"),
		])

		let request = try #require(await mock.lastRequest())
		let body = try #require(request.body)
		let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
		let events = try #require(json["events"] as? [[String: Any]])
		let event = try #require(events.first)
		#expect(event["destinationHost"] as? String == "news.example.com")
		#expect(String(decoding: body, as: UTF8.self).contains("/private/path") == false)
	}

	@Test func stateUpdateUsesExistingEditTagPath() async throws {
		let mock = MockHTTPClient()
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)

		try await client.updateItemState(
			readerId: "tag:google.com,2005:reader/item/0000000000000001",
			tag: "user/-/state/com.google/starred",
			enabled: true,
		)

		let request = try #require(await mock.lastRequest())
		#expect(request.url.path == "/reader/api/0/edit-tag")
		let body = String(decoding: request.body ?? Data(), as: UTF8.self)
		let form = try #require(URLComponents(string: "https://pigeon.test/?\(body)")?.queryItems)
		#expect(form.first(where: { $0.name == "i" })?.value == "tag:google.com,2005:reader/item/0000000000000001")
		#expect(form.first(where: { $0.name == "a" })?.value == "user/-/state/com.google/starred")
	}

	@Test func subscriptionsDecodeFoldersAndDeriveFeedKey() async throws {
		let response = Data(
			"""
			{"subscriptions":[{"id":"feed/7","title":"Daily","categories":[{"id":"user/-/label/News","label":"News"}],"url":"https://pigeon.test/feed/daily","sourceUrl":"https://example.com/feed.xml","htmlUrl":"https://example.com","iconUrl":""}]}
			""".utf8,
		)
		let mock = MockHTTPClient(responseData: response)
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)

		let subscriptions = try await client.subscriptions()

		let subscription = try #require(subscriptions.first)
		#expect(subscription.feedKey == "daily")
		#expect(subscription.sourceUrl?.absoluteString == "https://example.com/feed.xml")
		#expect(subscription.folderNames == ["News"])
		let request = try #require(await mock.lastRequest())
		#expect(request.url.path == "/reader/api/0/subscription/list")
		#expect(request.authorization == "GoogleLogin auth=pigeon/server-token")
	}

	@Test func feedManagementUsesGReaderQuickAddAndRepeatedFolderParameters() async throws {
		let response = Data(
			"""
			{"query":"https://example.com/feed.xml","numResults":1,"streamId":"feed/7","streamName":"Example"}
			""".utf8,
		)
		let mock = MockHTTPClient(responseData: response)
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)
		let feedURL = try #require(URL(string: "https://example.com/feed.xml"))

		let added = try await client.addSubscription(url: feedURL)
		try await client.editSubscription(
			id: added.streamId,
			title: "Example Daily",
			addingFolders: ["News", "Reading"],
			removingFolders: ["Old"],
		)

		let requests = await mock.requests()
		#expect(requests.first?.url.path == "/reader/api/0/subscription/quickadd")
		#expect(requests.first?.url.query?.contains("quickadd=https://example.com/feed.xml") == true)
		let edit = try #require(requests.last)
		let body = String(decoding: edit.body ?? Data(), as: UTF8.self)
		let form = try #require(URLComponents(string: "https://pigeon.test/?\(body)")?.queryItems)
		#expect(form.first(where: { $0.name == "ac" })?.value == "edit")
		#expect(form.first(where: { $0.name == "s" })?.value == "feed/7")
		#expect(form.filter { $0.name == "a" }.map(\.value) == ["user/-/label/News", "user/-/label/Reading"])
		#expect(form.filter { $0.name == "r" }.map(\.value) == ["user/-/label/Old"])
	}

	@Test func jsonErrorFieldIsShownInsteadOfGenericStatusFallback() {
		let error = PigeonError.server(
			statusCode: 404,
			message: #"{"error":"Unknown item tag:google.com,2005:reader/item/0000000000000001"}"#,
		)
		#expect(error.localizedDescription.contains("Unknown item"))
		#expect(error.localizedDescription.contains("404"))
		#expect(error.localizedDescription.contains("Pigeon returned an error") == false)
		#expect(error.isNonFatalEngagementFailure)
	}

	@Test func cloudflareResourceErrorUsesConciseUserFacingDescription() async throws {
		let payload = Data(
			"""
			{"title":"Error 1102: Worker exceeded resource limits","status":503,"error_code":1102,"error_name":"worker_exceeded_resources","ray_id":"a2aacd260d7a1c3f"}
			""".utf8,
		)
		let mock = MockHTTPClient(responseData: payload, statusCode: 503)
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)

		do {
			_ = try await client.readerUnreadCounts()
			Issue.record("Expected the server response to fail.")
		} catch let error as PigeonError {
			let description = error.localizedDescription
			#expect(description.contains("Cloudflare 1102"))
			#expect(description.contains("a2aacd260d7a1c3f"))
			#expect(description.contains("{\"title\"") == false)
			#expect(description.count < 240)
		} catch {
			Issue.record("Unexpected error: \(error)")
		}
	}

	@Test func unreadStreamRecommendationsExcludeReadItems() async throws {
		let mock = MockHTTPClient(responseData: Data(#"{"itemRefs":[]}"#.utf8))
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "server-token"),
			httpClient: mock,
		)

		_ = try await client.recommendationsPage(
			from: "user/-/state/com.google/reading-list",
			excludeTag: "user/-/state/com.google/read",
		)

		let request = try #require(await mock.lastRequest())
		let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
		#expect(request.url.path == "/reader/api/0/stream/items/ids")
		#expect(query.first(where: { $0.name == "s" })?.value == "user/-/state/com.google/reading-list")
		#expect(query.first(where: { $0.name == "xt" })?.value == "user/-/state/com.google/read")
	}

	@Test func folderRecommendationsReturnOneBoundedPageAndExposeContinuation() async throws {
		let mock = FolderLoadingHTTPClient()
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "server-token"),
			httpClient: mock,
		)

		let firstPage = try await client.recommendationsPage(from: "user/-/label/News")

		#expect(firstPage.items.count == 21)
		let expectedTitles = ["Newest"] + stride(from: 20, through: 1, by: -1).map { "Story \($0)" } + ["Older"]
		#expect(firstPage.items.map(\.title) == Array(expectedTitles.dropLast()))
		#expect(firstPage.continuation == "folder-page-2")

		var requests = await mock.requests()
		let itemIDRequests = requests.filter { $0.url.path == "/reader/api/0/stream/items/ids" }
		#expect(itemIDRequests.count == 1)
		#expect(itemIDRequests.allSatisfy { request in
			let queryItems = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
			return queryItems.first(where: { $0.name == "s" })?.value == "user/-/label/News"
				&& queryItems.first(where: { $0.name == "n" })?.value == "50"
		})

		let contentRequests = requests.filter { $0.url.path == "/reader/api/0/stream/items/contents" }
		#expect(contentRequests.count == 3)
		#expect(contentRequests.allSatisfy { $0.method == "POST" })
		let contentRequestIDs = contentRequests.map { Self.formValues(from: $0.body, named: "i") }
		let expectedContentRequestIDs: [[String]] = [
			Array((12...21).reversed()).map(String.init),
			Array((2...11).reversed()).map(String.init),
			["1"],
		]
		#expect(contentRequestIDs == expectedContentRequestIDs)
		#expect(contentRequestIDs.allSatisfy { $0.count <= 10 })
		#expect(requests.contains(where: { $0.url.path == "/reader/api/0/stream/contents" }) == false)

		let secondPage = try await client.recommendationsPage(
			from: "user/-/label/News",
			continuation: firstPage.continuation,
		)

		#expect(secondPage.items.map(\.title) == ["Older"])
		#expect(secondPage.continuation == nil)
		requests = await mock.requests()
		let allItemIDRequests = requests.filter { $0.url.path == "/reader/api/0/stream/items/ids" }
		#expect(allItemIDRequests.count == 2)
		let secondItemIDRequest = try #require(allItemIDRequests.dropFirst().first)
		#expect(URLComponents(url: secondItemIDRequest.url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "c" })?.value == "folder-page-2")
		let allContentRequests = requests.filter { $0.url.path == "/reader/api/0/stream/items/contents" }
		#expect(allContentRequests.count == 4)
		#expect(Self.formValues(from: allContentRequests.last?.body, named: "i") == ["0"])
	}

	@Test func folderRecommendationsReuseCachedBodiesInServerOrder() async throws {
		let mock = FolderLoadingHTTPClient()
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "server-token"),
			httpClient: mock,
		)
		let cached = (1...21).map { Self.cachedRecommendation(itemID: $0) }

		let page = try await client.recommendationsPage(
			from: "user/-/label/News",
			cachedRecommendations: cached,
		)

		#expect(page.items.map(\.title) == (1...21).reversed().map { "Cached \($0)" })
		#expect(page.continuation == "folder-page-2")
		let requests = await mock.requests()
		#expect(requests.filter { $0.url.path == "/reader/api/0/stream/items/ids" }.count == 1)
		#expect(requests.contains(where: { $0.url.path == "/reader/api/0/stream/items/contents" }) == false)
	}

	@Test func folderRecommendationsFetchOnlyMissingOrPrunedCachedBodies() async throws {
		let mock = FolderLoadingHTTPClient()
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "server-token"),
			httpClient: mock,
		)
		let cached = (1...21).map { itemID in
			Self.cachedRecommendation(itemID: itemID, html: itemID == 21 ? "" : "<p>Cached</p>")
		}

		let page = try await client.recommendationsPage(
			from: "user/-/label/News",
			cachedRecommendations: cached,
		)

		#expect(page.items.count == 21)
		#expect(page.items.first?.title == "Newest")
		#expect(page.items.dropFirst().map(\.title) == (1...20).reversed().map { "Cached \($0)" })
		let requests = await mock.requests()
		let contentRequests = requests.filter { $0.url.path == "/reader/api/0/stream/items/contents" }
		#expect(contentRequests.count == 1)
		#expect(Self.formValues(from: contentRequests.first?.body, named: "i") == ["21"])
	}

	@Test func legacyRecommendationsEntryPointDoesNotDrainFolderContinuations() async throws {
		let mock = FolderLoadingHTTPClient()
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "server-token"),
			httpClient: mock,
		)

		let recommendations = try await client.recommendations(from: "user/-/label/News")

		#expect(recommendations.count == 21)
		let requests = await mock.requests()
		#expect(requests.filter { $0.url.path == "/reader/api/0/stream/items/ids" }.count == 1)
		#expect(requests.filter { $0.url.path == "/reader/api/0/stream/items/contents" }.count == 3)
	}

	private static func formValues(from body: Data?, named name: String) -> [String] {
		let rawBody = String(decoding: body ?? Data(), as: UTF8.self)
		let queryItems = URLComponents(string: "https://pigeon.test/?\(rawBody)")?.queryItems ?? []
		return queryItems.filter { $0.name == name }.compactMap(\.value)
	}

	private static func cachedRecommendation(itemID: Int, html: String = "<p>Cached</p>") -> Recommendation {
		let hex = String(itemID, radix: 16)
		let paddedHex = String(repeating: "0", count: max(0, 16 - hex.count)) + hex
		return Recommendation(
			id: "cached-\(itemID)",
			readerId: "tag:google.com,2005:reader/item/\(paddedHex)",
			feedKey: "news",
			source: "News",
			title: "Cached \(itemID)",
			html: html,
			text: "Cached",
			originalURL: URL(string: "https://example.com/\(itemID)"),
			receivedAt: Date(timeIntervalSince1970: TimeInterval(1_786_272_000 + itemID)),
			isRead: false,
			isStarred: false,
			score: 0,
			confidence: 0,
			sampleCount: 0,
			explanation: "Cached",
			learningState: "Cached",
		)
	}
}

private actor SingleStreamHTTPClient: HTTPClient {
	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let url = request.url else {
			throw PigeonError.invalidServerURL
		}

		switch url.path {
		case "/reader/api/0/stream/items/ids":
			return (
				Data("{\"itemRefs\":[{\"id\":\"1\"}]}".utf8),
				try Self.response(for: url, statusCode: 200),
			)
		case "/reader/api/0/stream/items/contents":
			let payload = Data(
				"""
				{"id":"feed/7","updated":0,"items":[{"id":"tag:google.com,2005:reader/item/0000000000000001","categories":[],"title":"A useful story","author":"Alice Appleseed","published":1786272000,"summary":{"content":"<p>Hello</p>"},"content":{"content":"<p>Hello</p>"},"alternate":[],"origin":{"streamId":"feed/7","title":"Daily","htmlUrl":"https://example.com"}}]}
				""".utf8,
			)
			return (payload, try Self.response(for: url, statusCode: 200))
		default:
			return (Data("not found".utf8), try Self.response(for: url, statusCode: 404))
		}
	}

	private static func response(for url: URL, statusCode: Int) throws -> HTTPURLResponse {
		guard let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil) else {
			throw PigeonError.invalidResponse
		}
		return response
	}
}

private actor BlankAuthorStreamHTTPClient: HTTPClient {
	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let url = request.url else {
			throw PigeonError.invalidServerURL
		}

		switch url.path {
		case "/reader/api/0/stream/items/ids":
			return (
				Data("{\"itemRefs\":[{\"id\":\"1\"}]}".utf8),
				try Self.response(for: url, statusCode: 200),
			)
		case "/reader/api/0/stream/items/contents":
			let payload = Data(
				"""
				{"id":"feed/7","updated":0,"items":[{"id":"tag:google.com,2005:reader/item/0000000000000001","categories":[],"title":"A useful story","author":"","published":1786272000,"summary":{"content":"<p>Hello</p>"},"content":{"content":"<p>Hello</p>"},"alternate":[],"origin":{"streamId":"feed/7","title":"Daily","htmlUrl":"https://example.com"}}]}
				""".utf8,
			)
			return (payload, try Self.response(for: url, statusCode: 200))
		default:
			return (Data("not found".utf8), try Self.response(for: url, statusCode: 404))
		}
	}

	private static func response(for url: URL, statusCode: Int) throws -> HTTPURLResponse {
		guard let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil) else {
			throw PigeonError.invalidResponse
		}
		return response
	}
}

private actor FolderLoadingHTTPClient: HTTPClient {
	struct Request: Sendable {
		let url: URL
		let method: String?
		let body: Data?
	}

	private var capturedRequests: [Request] = []

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let url = request.url else {
			throw PigeonError.invalidServerURL
		}
		capturedRequests.append(Request(url: url, method: request.httpMethod, body: request.httpBody))

		switch url.path {
		case "/reader/api/0/stream/contents":
			let payload = Data("{\"error_code\":1102,\"error_name\":\"worker_exceeded_resources\",\"ray_id\":\"folder-ray\"}".utf8)
			return (payload, try Self.response(for: url, statusCode: 503))
		case "/reader/api/0/stream/items/ids":
			return try itemIDsResponse(for: url)
		case "/reader/api/0/stream/items/contents":
			let ids = Self.formValues(from: request.httpBody, named: "i")
			return (Self.contentsResponse(for: ids), try Self.response(for: url, statusCode: 200))
		default:
			return (Data("not found".utf8), try Self.response(for: url, statusCode: 404))
		}
	}

	func requests() -> [Request] {
		capturedRequests
	}

	private func itemIDsResponse(for url: URL) throws -> (Data, URLResponse) {
		let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
		guard queryItems.first(where: { $0.name == "s" })?.value == "user/-/label/News" else {
			return (Data("invalid stream".utf8), try Self.response(for: url, statusCode: 400))
		}

		let continuation = queryItems.first(where: { $0.name == "c" })?.value
		let payload: Data
		switch continuation {
		case nil:
			let itemRefs = (1...21).reversed().map { "{\"id\":\"\($0)\"}" }.joined(separator: ",")
			payload = Data("{\"itemRefs\":[\(itemRefs)],\"continuation\":\"folder-page-2\"}".utf8)
		case "folder-page-2":
			payload = Data("{\"itemRefs\":[{\"id\":\"0\"}]}".utf8)
		default:
			payload = Data("{\"itemRefs\":[]}".utf8)
		}
		return (payload, try Self.response(for: url, statusCode: 200))
	}

	private static func contentsResponse(for ids: [String]) -> Data {
		let items = ids.map { id in
			let title: String
			if id == "21" {
				title = "Newest"
			} else if id == "0" {
				title = "Older"
			} else {
				title = "Story \(id)"
			}
			let hexID = String(UInt64(id) ?? 0, radix: 16)
			let readerID = String(repeating: "0", count: max(0, 16 - hexID.count)) + hexID
			return "{\"id\":\"tag:google.com,2005:reader/item/\(readerID)\",\"categories\":[],\"title\":\"\(title)\",\"published\":1786272000,\"summary\":{\"content\":\"<p>Body</p>\"},\"content\":{\"content\":\"<p>Body</p>\"},\"alternate\":[],\"origin\":{\"streamId\":\"feed/7\",\"title\":\"News\",\"htmlUrl\":\"https://example.com\"}}"
		}.joined(separator: ",")
		return Data("{\"id\":\"user/-/state/com.google/reading-list\",\"updated\":0,\"items\":[\(items)]}".utf8)
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
