#if DEBUG
import Foundation

private nonisolated struct PreviewRecommendationsResponse: Encodable, Sendable {
	let generatedAt: Date
	let view: String
	let items: [Recommendation]
}

struct PreviewHTTPClient: HTTPClient {
	private let recommendations: [Recommendation]

	init(recommendations: [Recommendation] = []) {
		self.recommendations = recommendations
	}

	nonisolated func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let fallbackURL = URL(string: "https://pigeon.preview") else {
			throw PigeonError.invalidServerURL
		}
		let url = request.url ?? fallbackURL
		let data: Data
		var statusCode = 200
		switch url.path {
		case "/api/v1/recommendations":
			let response = PreviewRecommendationsResponse(
				generatedAt: Date(timeIntervalSince1970: 1_786_276_800),
				view: "preview",
				items: recommendations,
			)
			let encoder = JSONEncoder()
			encoder.dateEncodingStrategy = .iso8601
			data = try encoder.encode(response)
		case "/app/status":
			data = Data(Self.syncHealthFixture.utf8)
		case "/app/status/retry":
			data = Data("{\"feed_key\":\"design-weekly\",\"queued_at\":\"2026-08-15T14:30:00.000Z\"}".utf8)
		case "/reader/api/0/subscription/list":
			data = Data("{\"subscriptions\":[]}".utf8)
		case "/reader/api/0/unread-count":
			data = Data("{\"unreadcounts\":[]}".utf8)
		case "/reader/api/0/stream/items/ids":
			if ProcessInfo.processInfo.arguments.contains("-reader-folder-read-data") {
				let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
				let isSecondPage = query.contains { $0.name == "c" }
				let items = isSecondPage ? Array(recommendations.dropFirst().prefix(1)) : Array(recommendations.prefix(1))
				var page: [String: Any] = ["itemRefs": items.map { ["id": $0.readerId] }]
				if isSecondPage == false { page["continuation"] = "folder-mark-read-next" }
				data = try JSONSerialization.data(withJSONObject: page)
			} else if ProcessInfo.processInfo.arguments.contains("-reader-today-data") {
				data = try JSONSerialization.data(withJSONObject: [
					"itemRefs": recommendations.map { ["id": $0.readerId] },
				])
			} else {
				data = Data("{\"itemRefs\":[]}".utf8)
			}
		case "/reader/api/0/stream/items/contents":
			let showsFolderRead = ProcessInfo.processInfo.arguments.contains("-reader-folder-read-data")
			if showsFolderRead || ProcessInfo.processInfo.arguments.contains("-reader-today-data") {
				let requestedIDs = Set((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [])
					.filter { $0.name == "i" }.compactMap(\.value))
				let items = showsFolderRead ? recommendations.filter { requestedIDs.contains($0.readerId) } : recommendations
				data = try JSONSerialization.data(withJSONObject: [
					"id": "user/-/state/com.google/reading-list",
					"items": items.map { article -> [String: Any] in
						let streamID = showsFolderRead
							? "feed/\((recommendations.firstIndex(where: { $0.id == article.id }) ?? 0) + 1)"
							: "feed/\(article.feedKey)"
						return [
							"id": article.readerId,
							"categories": article.isRead ? ["user/-/state/com.google/read"] : [],
							"title": article.title,
							"published": Int(article.receivedAt.timeIntervalSince1970),
							"summary": ["content": article.html],
							"alternate": [["href": article.originalURL?.absoluteString ?? ""]],
							"origin": ["streamId": streamID, "title": article.source],
						]
					},
				])
			} else {
				data = Data("{\"items\":[]}".utf8)
			}
		case "/feeds/youtube/search":
			let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?
				.queryItems?
				.first(where: { $0.name == "q" })?.value?.lowercased()
			data = Data((query == "mkbhd" || query == "@mkbhd"
				? Self.youtubeSearchFixture
				: Self.youtubeEmptySearchFixture).utf8)
		case "/reader/api/0/subscription/quickadd":
			let requestedURL = URLComponents(url: url, resolvingAgainstBaseURL: false)?
				.queryItems?
				.first(where: { $0.name == "quickadd" })?.value
			if requestedURL == Self.youtubeQuickAddURL {
				data = Data(Self.youtubeQuickAddFixture.utf8)
			} else {
				data = Data("Unexpected preview subscription URL".utf8)
				statusCode = 400
			}
		case "/reader/api/0/subscription/edit":
			if ProcessInfo.processInfo.arguments.contains("-reader-show-add-feed") {
				let rawBody = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
				let form = URLComponents(string: "https://pigeon.preview/?\(rawBody)")?.queryItems ?? []
				let hasExpectedFeed = form.contains {
					$0.name == "s" && $0.value == "feed/youtube/UCBJycsmduvYEL83R_U4JriQ"
				}
				let hasExpectedFolder = form.contains {
					$0.name == "a" && $0.value == "user/-/label/Creators"
				}
				if hasExpectedFeed && hasExpectedFolder {
					data = Data()
				} else {
					data = Data("Unexpected preview folder assignment".utf8)
					statusCode = 400
				}
			} else {
				data = Data()
			}
		default:
			if ProcessInfo.processInfo.arguments.contains("-reader-reader-success"), url.path == "/design" {
				data = Data("""
				<!doctype html><html><head><title>Reader View proof</title></head>
				<body><nav>Preview navigation</nav><article>
				<h1>Reader View proof</h1><p>This is a deterministic Reader View success fixture.</p>
				<p><a href="/reader-related">A relative Reader View link</a> remains interactive.</p>
				</article></body></html>
				""".utf8)
			} else {
				data = Data("<html><head></head><body></body></html>".utf8)
			}
		}
		guard let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil) else {
			throw PigeonError.invalidResponse
		}
		return (data, response)
	}

	nonisolated private static let syncHealthFixture = """
	{
	  "syncHealth": {
	    "generatedAt": "2026-08-15T14:30:00.000Z",
	    "dueCount": 1,
	    "backedOffCount": 0,
	    "leasedCount": 0,
	    "healthyCount": 2,
	    "feeds": [{
	      "feedKey": "design-weekly",
	      "title": "Design Weekly",
	      "host": "design.example.com",
	      "state": "failing",
	      "lastAttemptAt": "2026-08-15T14:20:00.000Z",
	      "lastSuccessAt": "2026-08-14T14:20:00.000Z",
	      "nextFetchAt": "2026-08-15T14:30:00.000Z",
	      "retryAt": null,
	      "consecutiveFailures": 1,
	      "httpStatus": 503,
	      "outcome": "http_error",
	      "durationMs": 520,
	      "error": "HTTP 503",
	      "canRetry": true
	    }],
	    "recentActivity": [{
	      "feedKey": "design-weekly",
	      "title": "Design Weekly",
	      "attemptedAt": "2026-08-15T14:20:00.000Z",
	      "outcome": "http_error",
	      "httpStatus": 503,
	      "durationMs": 520,
	      "itemsProcessed": 0,
	      "errorCode": "http_503",
	      "error": "HTTP 503",
	      "retryAt": null
	    }]
	  }
	}
	"""

	nonisolated private static let youtubeSearchFixture = """
	{
	  "channels": [{
	    "id": "UCBJycsmduvYEL83R_U4JriQ",
	    "title": "Marques Brownlee",
	    "description": "",
	    "channelUrl": "https://www.youtube.com/@mkbhd",
	    "feedUrl": "https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ",
	    "thumbnailUrl": null
	  }],
	  "mode": "handle",
	  "message": null
	}
	"""

	nonisolated private static let youtubeEmptySearchFixture = """
	{
	  "channels": [],
	  "mode": "search",
	  "message": null
	}
	"""

	nonisolated private static let youtubeQuickAddURL = "https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ"

	nonisolated private static let youtubeQuickAddFixture = """
	{
	  "query": "https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ",
	  "numResults": 1,
	  "streamId": "feed/youtube/UCBJycsmduvYEL83R_U4JriQ",
	  "streamName": "Marques Brownlee",
	  "isNew": true
	}
	"""
}

/// A DEBUG-only HTTP fixture for proving launch ordering with the real reader
/// model. It returns bounded Reader API pages immediately while deliberately
/// holding the unrelated incremental sync request open.
nonisolated struct LaunchFixtureHTTPClient: HTTPClient {
	private static let syncHoldNanoseconds: UInt64 = 30_000_000_000

	let scenario: PreviewData.LaunchFixtureScenario
	let articles: [Recommendation]

	init(scenario: PreviewData.LaunchFixtureScenario, articles: [Recommendation]) {
		self.scenario = scenario
		self.articles = articles
	}

	nonisolated func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let fallbackURL = URL(string: "https://pigeon.launch-fixture") else {
			throw PigeonError.invalidServerURL
		}
		let url = request.url ?? fallbackURL
		print("[LaunchFixture] \(scenario.rawValue) request \(url.path)")

		if url.path == "/api/v1/sync" {
			switch scenario {
			case .emptyColdToday, .cachedSelectedList:
				// This is the unrelated full/incremental sync. Keep it pending long
				// enough for a screenshot or UI assertion to prove the visible page
				// arrived first.
				try await Task.sleep(nanoseconds: Self.syncHoldNanoseconds)
			case .replayFailure:
				break
			}
			return try Self.response(data: Self.completeSyncPageData, url: url)
		}

		if url.path == "/api/v1/mutations", scenario == .replayFailure {
			throw PigeonError.server(
				statusCode: 503,
				message: "{\"error\":\"Launch fixture replay failed\"}",
			)
		}

		let data: Data
		switch url.path {
		case "/api/v1/recommendations":
			let payload = PreviewRecommendationsResponse(
				generatedAt: Date(timeIntervalSince1970: 1_788_000_000),
				view: "launch-fixture",
				items: articles,
			)
			let encoder = JSONEncoder()
			encoder.dateEncodingStrategy = .iso8601
			data = try encoder.encode(payload)
		case "/reader/api/0/subscription/list":
			data = Data(Self.subscriptionListData.utf8)
		case "/reader/api/0/unread-count":
			data = try JSONSerialization.data(withJSONObject: [
				"unreadcounts": [
					["id": "feed/launch-fixture", "count": articles.count],
					["id": "user/-/state/com.google/reading-list", "count": articles.count],
				],
			])
		case "/reader/api/0/stream/items/ids":
			data = try JSONSerialization.data(withJSONObject: [
				"itemRefs": articles.map { ["id": $0.readerId] },
				"continuation": NSNull(),
			])
		case "/reader/api/0/stream/items/contents":
			data = try Self.streamContentsData(for: articles)
		default:
			data = Data("{}".utf8)
		}
		return try Self.response(data: data, url: url)
	}

	private static let completeSyncPageData = Data(
		"{\"cursor\":\"launch-fixture-cursor\",\"hasMore\":false,\"changes\":[]}".utf8,
	)

	private static let subscriptionListData = """
	{"subscriptions":[{"id":"feed/launch-fixture","title":"Launch Fixture Reads","categories":[],"url":"https://pigeon.launch-fixture/feed/launch-fixture","sourceUrl":"https://example.invalid/launch-fixture","htmlUrl":"https://example.invalid/launch-fixture","iconUrl":null}]}
	"""

	private static func streamContentsData(for articles: [Recommendation]) throws -> Data {
		let items: [[String: Any]] = articles.map { article in
			var item: [String: Any] = [
				"id": article.readerId,
				"categories": [
					article.isRead ? "user/-/state/com.google/read" : "",
					article.isStarred ? "user/-/state/com.google/starred" : "",
				].filter { $0.isEmpty == false },
				"title": article.title,
				"published": Int(article.receivedAt.timeIntervalSince1970),
				"summary": ["content": article.html],
				"alternate": [["href": article.originalURL?.absoluteString ?? "https://example.invalid/launch-fixture"]],
				"origin": [
					"streamId": "feed/\(article.feedKey)",
					"title": article.source,
					"htmlUrl": "https://example.invalid/launch-fixture",
				],
			]
			if let author = article.author {
				item["author"] = author
			}
			return item
		}
		return try JSONSerialization.data(withJSONObject: [
			"id": "user/-/state/com.google/reading-list",
			"items": items,
		])
	}

	private static func response(data: Data, url: URL) throws -> (Data, URLResponse) {
		guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
			throw PigeonError.invalidResponse
		}
		return (data, response)
	}
}
#endif
