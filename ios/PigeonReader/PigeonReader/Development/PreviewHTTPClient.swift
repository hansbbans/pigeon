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
}
#endif
