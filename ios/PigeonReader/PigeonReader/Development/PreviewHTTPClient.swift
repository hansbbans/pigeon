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
		if ProcessInfo.processInfo.arguments.contains("-reader-motion-stress-fixture"),
			let fixture = try PreviewMotionStreamFixture.data(for: request),
			let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) {
			return (fixture, response)
		}
		if ProcessInfo.processInfo.arguments.contains("-reader-paging-fixture"),
			url.path == "/reader/api/0/stream/items/contents" {
			let form = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
			let ids = URLComponents(string: "https://pigeon.preview/?\(form)")?.queryItems?.filter { $0.name == "i" }.compactMap(\.value) ?? []
			let items: [[String: Any]] = ids.map { id in
				let number = Int(id.replacingOccurrences(of: "paging-", with: "")) ?? 0
				return ["id": id, "title": "Paging story \(number)", "published": 1_786_272_000 - number,
					"summary": ["content": "<p>Deterministic paging and return-position fixture \(number).</p>"],
					"origin": ["streamId": "feed/1", "title": "Dense Discovery"], "categories": []]
			}
			guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
				throw PigeonError.invalidResponse
			}
			return (try JSONSerialization.data(withJSONObject: ["id": "feed/1", "items": items]), response)
		}
		let data: Data
		var statusCode = 200
		switch url.path {
		case "/api/v3/save/":
			// Preview mode never contacts Readwise; this drives the save feedback UI.
			data = Data("{}".utf8)
			statusCode = 201
		case "/api/v1/recommendations":
			let response = PreviewRecommendationsResponse(
				generatedAt: Date(timeIntervalSince1970: 1_786_276_800),
				view: "preview",
				items: recommendations,
			)
			let encoder = JSONEncoder()
			encoder.dateEncodingStrategy = .iso8601
			data = try encoder.encode(response)
		case "/api/v1/personalization":
			if request.httpMethod == "DELETE" {
				data = Data()
			} else {
				let topics = request.httpMethod == "PUT" ? Self.monitoredTopics(from: request.httpBody) : []
				data = try Self.personalizationData(topics: topics)
			}
		case "/app/status":
			data = Data(Self.syncHealthFixture.utf8)
		case "/app/status/retry":
			data = Data("{\"feed_key\":\"design-weekly\",\"queued_at\":\"2026-08-15T14:30:00.000Z\"}".utf8)
		case "/reader/api/0/subscription/list":
			if ProcessInfo.processInfo.arguments.contains("-reader-paging-fixture") {
				// Refreshing navigation must preserve the selected paging feed.
				data = try JSONSerialization.data(withJSONObject: ["subscriptions": [[
					"id": "feed/1", "title": "Dense Discovery",
					"categories": [["id": "user/-/label/Design", "label": "Design"]],
					"url": "https://pigeon.preview/feed/dense-discovery",
				]]])
			} else if ProcessInfo.processInfo.arguments.contains("-reader-navigation-fixture") {
				data = try JSONSerialization.data(withJSONObject: [
					"subscriptions": Self.navigationFixtureSubscriptions,
				])
			} else {
				data = Data("{\"subscriptions\":[]}".utf8)
			}
		case "/reader/api/0/unread-count":
			if ProcessInfo.processInfo.arguments.contains("-reader-navigation-fixture") {
				data = try JSONSerialization.data(withJSONObject: [
					"unreadcounts": Self.navigationFixtureUnreadCounts,
				])
			} else {
				data = Data("{\"unreadcounts\":[]}".utf8)
			}
		case "/reader/api/0/stream/items/ids":
			if ProcessInfo.processInfo.arguments.contains("-reader-navigation-fixture") {
				let stream = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "s" }?.value
				if stream == "feed/navigation-1-2" {
					let navigationError = ProcessInfo.processInfo.arguments.contains("-reader-navigation-error")
					try await Task.sleep(for: .seconds(navigationError ? 2 : 5))
					if navigationError {
						statusCode = 503
					}
				}
				let refreshFixture = ProcessInfo.processInfo.arguments.contains("-reader-folder-refresh-fixture")
				let itemIDs: [String] = switch stream {
				case "user/-/label/Folder 01" where refreshFixture:
					[
						"tag:google.com,2005:reader/item/0000000000000001",
						"tag:google.com,2005:reader/item/0000000000000005",
					]
				case "feed/navigation-1-1":
					refreshFixture
						? [
							"tag:google.com,2005:reader/item/0000000000000001",
							"tag:google.com,2005:reader/item/0000000000000005",
						]
						: ["tag:google.com,2005:reader/item/0000000000000001"]
				case "feed/navigation-1-3": ["tag:google.com,2005:reader/item/0000000000000002"]
				case "user/-/state/com.google/starred": recommendations.filter(\.isStarred).map(\.readerId)
				case "user/-/state/com.google/reading-list": recommendations.filter { $0.isRead == false }.prefix(2).map(\.readerId)
				default: []
				}
				data = try JSONSerialization.data(withJSONObject: ["itemRefs": itemIDs.map { ["id": $0] }])
			} else if ProcessInfo.processInfo.arguments.contains("-reader-paging-fixture") {
				let next = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains { $0.name == "c" } == true
				let range = next ? 13...24 : 1...12
				var payload: [String: Any] = ["itemRefs": range.map { ["id": "paging-\($0)"] }]
				if next == false { payload["continuation"] = "second-page" }
				data = try JSONSerialization.data(withJSONObject: payload)
			} else if ProcessInfo.processInfo.arguments.contains("-reader-folder-read-data") {
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
			if ProcessInfo.processInfo.arguments.contains("-reader-navigation-fixture"),
				ProcessInfo.processInfo.arguments.contains("-reader-folder-refresh-fixture") {
				let form = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
				let ids = URLComponents(string: "https://pigeon.preview/?\(form)")?.queryItems?.filter { $0.name == "i" }.compactMap(\.value) ?? []
				let items: [[String: Any]] = ids.compactMap { id in
					switch id {
					case "tag:google.com,2005:reader/item/0000000000000001":
						return [
							"id": id,
							"title": "Designing calmer tools after refresh",
							"published": 1_786_272_200,
							"summary": ["content": "<p>The cached story now has its revised body.</p>"],
							"content": ["content": "<p>The cached story now has its revised body.</p>"],
							"origin": ["streamId": "user/-/label/Folder 01", "title": "Folder 01", "htmlUrl": "https://example.com"],
						]
					case "tag:google.com,2005:reader/item/0000000000000005":
						return [
							"id": id,
							"title": "A new story arrived while you were away",
							"published": 1_786_272_201,
							"summary": ["content": "<p>A new story appeared during the automatic refresh.</p>"],
							"content": ["content": "<p>A new story appeared during the automatic refresh.</p>"],
							"origin": ["streamId": "user/-/label/Folder 01", "title": "Folder 01", "htmlUrl": "https://example.com"],
						]
					default: return nil
					}
				}
				data = try JSONSerialization.data(withJSONObject: [
					"id": "user/-/label/Folder 01",
					"items": items,
				])
			} else {
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

	private static func monitoredTopics(from body: Data?) -> [String] {
		guard let body,
			let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
			let topics = object["monitoredTopics"] as? [String] else {
			return []
		}
		return topics
	}

	private static func personalizationData(topics: [String]) throws -> Data {
		try JSONSerialization.data(withJSONObject: [
			"exportedAt": "2026-08-15T12:00:00Z",
			"policy": [
				"plainLanguageSummary": "Preview signals",
				"confirmedSignals": [],
				"confirmationRule": "Confirmed",
				"retention": "Retained",
			],
			"history": [],
			"monitoredTopics": topics,
		])
	}

	nonisolated private static var navigationFixtureSubscriptions: [[String: Any]] {
		let stress = ProcessInfo.processInfo.arguments.contains("-reader-motion-stress-fixture")
		let folderCount = stress ? 100 : 6
		let feedCount = stress ? 30 : 6
		return (1...folderCount).flatMap { folderNumber in
			let folderTitle = String(format: "Folder %02d", folderNumber)
			return (1...feedCount).map { feedNumber in
				let feedID = "feed/navigation-\(folderNumber)-\(feedNumber)"
				return [
					"id": feedID,
					"title": String(format: "Feed %02d.%02d", folderNumber, feedNumber),
					"categories": [["id": "navigation-folder-\(folderNumber)", "label": folderTitle]],
					"url": "https://pigeon.preview/\(feedID)",
				]
			}
		}
	}

	nonisolated private static var navigationFixtureUnreadCounts: [[String: Any]] {
		let stress = ProcessInfo.processInfo.arguments.contains("-reader-motion-stress-fixture")
		let folderCount = stress ? 100 : 6
		let feedCount = stress ? 30 : 6
		var counts: [[String: Any]] = [
			["id": "user/-/state/com.google/reading-list", "count": 2],
			["id": "user/-/state/com.google/starred", "count": 1],
		]
		for folderNumber in 1...folderCount {
			counts.append(["id": "navigation-folder-\(folderNumber)", "count": 6])
			for feedNumber in 1...feedCount {
				counts.append(["id": "feed/navigation-\(folderNumber)-\(feedNumber)", "count": 1])
			}
		}
		return counts
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
