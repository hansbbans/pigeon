import Foundation
import Testing
@testable import PigeonReader

struct SyncHealthAPIClientTests {
	@Test func syncHealthDecodesServerStatusAndUsesReaderAuthorization() async throws {
		let response = Data(
			"""
			{
			  "syncHealth": {
			    "generatedAt": "2026-08-15T14:30:00.123Z",
			    "dueCount": 1,
			    "backedOffCount": 1,
			    "leasedCount": 0,
			    "healthyCount": 2,
			    "feeds": [{
			      "feedKey": "example",
			      "title": "Example",
			      "host": "example.com",
			      "state": "failing",
			      "lastAttemptAt": "2026-08-15T14:29:00.000Z",
			      "lastSuccessAt": null,
			      "nextFetchAt": "2026-08-15T14:35:00.000Z",
			      "retryAt": null,
			      "consecutiveFailures": 2,
			      "httpStatus": 503,
			      "outcome": "http_error",
			      "durationMs": 840,
			      "error": "HTTP 503",
			      "canRetry": true
			    }],
			    "recentActivity": [{
			      "feedKey": "example",
			      "title": "Example",
			      "attemptedAt": "2026-08-15T14:29:00.000Z",
			      "outcome": "http_error",
			      "httpStatus": 503,
			      "durationMs": 840,
			      "itemsProcessed": 0,
			      "errorCode": "http_503",
			      "error": "HTTP 503",
			      "retryAt": null
			    }]
			  }
			}
			""".utf8,
		)
		let mock = MockHTTPClient(responseData: response)
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "server-token"),
			httpClient: mock,
		)

		let health = try await client.syncHealth()

		#expect(health.dueCount == 1)
		#expect(health.feeds.first?.host == "example.com")
		#expect(health.recentActivity.first?.itemsProcessed == 0)
		let request = try #require(await mock.lastRequest())
		#expect(request.url.path == "/app/status")
		#expect(request.method == "GET")
		#expect(request.authorization == "GoogleLogin auth=pigeon/server-token")
	}

	@Test func retryFeedPostsOnlyTheOpaqueFeedKey() async throws {
		let mock = MockHTTPClient(responseData: Data("{}".utf8))
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "server-token"),
			httpClient: mock,
		)

		try await client.retryFeed(feedKey: "example-feed")

		let request = try #require(await mock.lastRequest())
		#expect(request.url.path == "/app/status/retry")
		#expect(request.method == "POST")
		#expect(request.contentType == "application/json; charset=utf-8")
		let body = try #require(request.body)
		let payload = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
		#expect(payload == ["feed_key": "example-feed"])
		#expect(request.authorization == "GoogleLogin auth=pigeon/server-token")
	}
}
