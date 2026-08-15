#if DEBUG
import Foundation

struct PreviewHTTPClient: HTTPClient {
	nonisolated func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let fallbackURL = URL(string: "https://pigeon.preview") else {
			throw PigeonError.invalidServerURL
		}
		let url = request.url ?? fallbackURL
		let data: Data
		switch url.path {
		case "/api/v1/recommendations":
			data = Data("{\"generatedAt\":\"2026-08-09T12:00:00Z\",\"view\":\"preview\",\"items\":[]}".utf8)
		case "/app/status":
			data = Data(Self.syncHealthFixture.utf8)
		case "/app/status/retry":
			data = Data("{\"feed_key\":\"design-weekly\",\"queued_at\":\"2026-08-15T14:30:00.000Z\"}".utf8)
		case "/reader/api/0/subscription/list":
			data = Data("{\"subscriptions\":[]}".utf8)
		case "/reader/api/0/unread-count":
			data = Data("{\"unreadcounts\":[]}".utf8)
		case "/reader/api/0/stream/items/ids":
			data = Data("{\"itemRefs\":[]}".utf8)
		case "/reader/api/0/stream/items/contents":
			data = Data("{\"items\":[]}".utf8)
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
		guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
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
}
#endif
