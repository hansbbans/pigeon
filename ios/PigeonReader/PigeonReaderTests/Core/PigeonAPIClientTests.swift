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

	@Test func streamRecommendationsIncludeTheOriginSourceInTheirExplanation() async throws {
		let response = Data(
			"""
			{"id":"feed/7","updated":0,"items":[{"id":"tag:google.com,2005:reader/item/0000000000000001","categories":[],"title":"A useful story","published":1786272000,"summary":{"content":"<p>Hello</p>"},"content":{"content":"<p>Hello</p>"},"alternate":[],"origin":{"streamId":"feed/7","title":"Daily","htmlUrl":"https://example.com"}}]}
			""".utf8,
		)
		let mock = MockHTTPClient(responseData: response)
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)

		let items = try await client.recommendations(from: "feed/7")

		#expect(items.first?.explanation == "From Daily")
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
			{"subscriptions":[{"id":"feed/7","title":"Daily","categories":[{"id":"user/-/label/News","label":"News"}],"url":"https://pigeon.test/feed/daily","htmlUrl":"https://example.com","iconUrl":""}]}
			""".utf8,
		)
		let mock = MockHTTPClient(responseData: response)
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: baseURL, token: "server-token"), httpClient: mock)

		let subscriptions = try await client.subscriptions()

		let subscription = try #require(subscriptions.first)
		#expect(subscription.feedKey == "daily")
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
}
