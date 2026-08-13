import Foundation
@testable import PigeonReader

actor NavigationHTTPClient: HTTPClient {
	private let subscriptionResponse: Data
	private let unreadResponse: Data
	private let starredFirstPage: Data
	private let starredSecondPage: Data
	private let todayFirstPage: Data
	private let todaySecondPage: Data
	private var requestURLs: [URL] = []

	init(now: Date, dayBounds: ReaderLocalDayBounds) {
		subscriptionResponse = Data(
			"""
			{"subscriptions":[
				{"id":"feed/7","title":"Alpha","categories":[{"id":"user/-/label/Work","label":"Work"},{"id":"user/-/label/Work","label":"Work"},{"id":"user/-/label/News","label":"News"}],"url":"https://pigeon.test/feed/alpha"},
				{"id":"feed/8","title":"Bravo","categories":[{"id":"user/-/label/Work","label":"Work"}],"url":"https://pigeon.test/feed/bravo"},
				{"id":"feed/9","title":"Unfiled","categories":[],"url":"https://pigeon.test/feed/unfiled"}
			]}
			""".utf8,
		)
		unreadResponse = Data(
			"""
			{"max":1000,"unreadcounts":[
				{"id":"feed/7","count":4,"newestItemTimestampUsec":"0"},
				{"id":"feed/8","count":3,"newestItemTimestampUsec":"0"},
				{"id":"feed/9","count":1,"newestItemTimestampUsec":"0"},
				{"id":"user/-/label/News","count":4,"newestItemTimestampUsec":"0"},
				{"id":"user/-/label/Work","count":7,"newestItemTimestampUsec":"0"},
				{"id":"user/-/state/com.google/reading-list","count":8,"newestItemTimestampUsec":"0"}
			]}
			""".utf8,
		)
		starredFirstPage = Self.streamResponse(
			streamID: "user/-/state/com.google/starred",
			items: [Self.itemJSON(id: "starred-1", published: Int(now.timeIntervalSince1970), categories: ["user/-/state/com.google/reading-list", "user/-/state/com.google/starred"])],
			continuation: "starred-2",
		)
		starredSecondPage = Self.streamResponse(
			streamID: "user/-/state/com.google/starred",
			items: [Self.itemJSON(id: "starred-2", published: dayBounds.startSeconds - 86_400, categories: ["user/-/state/com.google/reading-list", "user/-/state/com.google/starred"])],
			continuation: nil,
		)
		todayFirstPage = Self.streamResponse(
			streamID: "user/-/state/com.google/reading-list",
			items: [Self.itemJSON(id: "today-1", published: dayBounds.startSeconds + 3_600, categories: ["user/-/state/com.google/reading-list"])],
			continuation: "today-2",
		)
		todaySecondPage = Self.streamResponse(
			streamID: "user/-/state/com.google/reading-list",
			items: [Self.itemJSON(id: "yesterday-1", published: dayBounds.startSeconds - 1, categories: ["user/-/state/com.google/reading-list"])],
			continuation: nil,
		)
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let url = request.url else {
			throw PigeonError.invalidServerURL
		}
		requestURLs.append(url)
		let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
		let streamID = query.first(where: { $0.name == "s" })?.value
		let continuation = query.first(where: { $0.name == "c" })?.value
		let responseData: Data
		switch url.path {
		case "/reader/api/0/subscription/list":
			responseData = subscriptionResponse
		case "/reader/api/0/unread-count":
			responseData = unreadResponse
		case "/reader/api/0/stream/contents":
			switch (streamID, continuation) {
			case ("user/-/state/com.google/starred", nil): responseData = starredFirstPage
			case ("user/-/state/com.google/starred", "starred-2"): responseData = starredSecondPage
			case ("user/-/state/com.google/reading-list", nil): responseData = todayFirstPage
			case ("user/-/state/com.google/reading-list", "today-2"): responseData = todaySecondPage
			default: responseData = Self.streamResponse(streamID: streamID ?? "", items: [], continuation: nil)
			}
		default:
			let errorResponse = try Self.response(for: url, statusCode: 404)
			return (Data("not found".utf8), errorResponse)
		}
		return (responseData, try Self.response(for: url, statusCode: 200))
	}

	func requests() -> [URL] {
		requestURLs
	}

	private static func response(for url: URL, statusCode: Int) throws -> HTTPURLResponse {
		guard let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil) else {
			throw PigeonError.invalidResponse
		}
		return response
	}

	private static func itemJSON(id: String, published: Int, categories: [String]) -> String {
		let encodedCategories = categories.map { "\"\($0)\"" }.joined(separator: ",")
		return "{\"id\":\"\(id)\",\"categories\":[\(encodedCategories)],\"title\":\"Story\",\"published\":\(published),\"summary\":{\"content\":\"<p>Body</p>\"},\"content\":{\"content\":\"<p>Body</p>\"},\"alternate\":[],\"origin\":{\"streamId\":\"feed/7\",\"title\":\"Alpha\",\"htmlUrl\":\"https://example.com\"}}"
	}

	private static func streamResponse(streamID: String, items: [String], continuation: String?) -> Data {
		let continuationJSON = continuation.map { ",\"continuation\":\"\($0)\"" } ?? ""
		return Data("{\"id\":\"\(streamID)\",\"updated\":0,\"items\":[\(items.joined(separator: ","))]\(continuationJSON)}".utf8)
	}
}
