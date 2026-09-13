import Foundation
import Testing
@testable import PigeonReader

struct YouTubeChannelSearchTests {
	@Test
	func responseDecodesCamelCaseFieldsAndHandleMode() throws {
		let data = Data(
			#"{"channels":[{"id":"UC123","title":"MKBHD","description":"Tech videos","channelUrl":"https://www.youtube.com/@mkbhd","feedUrl":"https://pigeon.test/feeds/youtube/mkbhd","thumbnailUrl":null}],"mode":"handle","message":null}"#.utf8,
		)

		let response = try JSONDecoder().decode(YouTubeChannelSearchResponse.self, from: data)
		let channel = try #require(response.channels.first)

		#expect(response.mode == .handle)
		#expect(response.message == nil)
		#expect(channel.title == "MKBHD")
		#expect(channel.description == "Tech videos")
		#expect(channel.channelLabel == "@mkbhd")
		#expect(channel.thumbnailURL == nil)
		#expect(channel.validFeedURL?.absoluteString == "https://pigeon.test/feeds/youtube/mkbhd")
	}

	@Test
	func searchBuildsTrimmedAuthorizedGetRequest() async throws {
		let mock = MockHTTPClient(responseData: Data(#"{"channels":[],"mode":"search","message":"No matches"}"#.utf8))
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "server-token"),
			httpClient: mock,
		)

		let response = try await client.searchYouTubeChannels(query: "  mkbhd  ")
		let request = try #require(await mock.lastRequest())
		let queryItems = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []

		#expect(response.message == "No matches")
		#expect(request.url.path == "/feeds/youtube/search")
		#expect(request.method == "GET")
		#expect(request.authorization == "GoogleLogin auth=pigeon/server-token")
		#expect(request.accept == "application/json")
		#expect(queryItems.first(where: { $0.name == "q" })?.value == "mkbhd")
	}

	@Test
	func shortQueriesReturnGuidanceWithoutNetworking() async throws {
		let mock = MockHTTPClient()
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "server-token"),
			httpClient: mock,
		)

		let response = try await client.searchYouTubeChannels(query: " a ")

		#expect(response.channels.isEmpty)
		#expect(response.message == "Enter at least 2 characters to search.")
		#expect(await mock.lastRequest() == nil)
	}

	@Test
	func searchPropagatesHTTPFailuresToTheInlineCaller() async throws {
		let mock = MockHTTPClient(responseData: Data("search unavailable".utf8), statusCode: 503)
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "server-token"),
			httpClient: mock,
		)

		do {
			_ = try await client.searchYouTubeChannels(query: "mkbhd")
			Issue.record("Expected the search request to fail.")
		} catch let PigeonError.server(statusCode, message) {
			#expect(statusCode == 503)
			#expect(message == "search unavailable")
		} catch {
			Issue.record("Unexpected search error: \(error)")
		}
	}

	@Test
	func searchPropagatesCancellationFromTheHTTPClient() async throws {
		let probe = CancellationProbeHTTPClient()
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let client = PigeonAPIClient(
			session: PigeonSession(baseURL: baseURL, token: "server-token"),
			httpClient: probe,
		)
		let requestTask = Task {
			try await client.searchYouTubeChannels(query: "mkbhd")
		}

		await probe.waitUntilStarted()
		requestTask.cancel()
		do {
			_ = try await requestTask.value
			Issue.record("Expected cancellation to reach the search caller.")
		} catch is CancellationError {
			// SwiftUI treats this as a normal task replacement.
		} catch {
			Issue.record("Unexpected cancellation error: \(error)")
		}
}

	@Test
	func staleResultsCannotReplaceAnewerQuery() throws {
		var state = YouTubeChannelSearchState()
		state.updateInput("mkbhd")
		let oldRequest = state.request
		state.updateInput("linus")
		let currentRequest = state.request
		let response = YouTubeChannelSearchResponse(
			channels: [makeChannel(id: "UC-linus", title: "Linus Tech Tips")],
			mode: .search,
			message: nil,
		)

		let acceptedOldResponse = state.apply(response, for: oldRequest)
		#expect(acceptedOldResponse == false)
		#expect(state.channels.isEmpty)
		let acceptedCurrentResponse = state.apply(response, for: currentRequest)
		#expect(acceptedCurrentResponse)
		#expect(state.channels.first?.title == "Linus Tech Tips")
	}

	@Test
	func editingInputClearsSelectionAndResultsImmediately() throws {
		var state = YouTubeChannelSearchState()
		state.updateInput("mkbhd")
		let request = state.request
		let channel = makeChannel(id: "UC-mkbhd", title: "MKBHD")
		_ = state.apply(
			YouTubeChannelSearchResponse(channels: [channel], mode: .search, message: nil),
			for: request,
		)
		state.select(channel)

		state.updateInput("https://example.com/feed.xml")

		#expect(state.channels.isEmpty)
		#expect(state.selectedChannel == nil)
		#expect(state.message == nil)
		#expect(state.errorMessage == nil)
		#expect(state.isSearching == false)
	}

	private func makeChannel(id: String, title: String) -> YouTubeChannelSearchResult {
		YouTubeChannelSearchResult(
			id: id,
			title: title,
			description: "Description",
			channelURL: "https://www.youtube.com/@channel",
			feedURL: "https://pigeon.test/feeds/youtube/channel",
			thumbnailURL: nil,
		)
	}
}

private actor CancellationProbeHTTPClient: HTTPClient {
	private var started = false
	private var waiters: [CheckedContinuation<Void, Never>] = []

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		started = true
		for waiter in waiters {
			waiter.resume()
		}
		waiters.removeAll()
		try await Task.sleep(nanoseconds: 60_000_000_000)
		throw CancellationError()
	}

	func waitUntilStarted() async {
		if started { return }
		await withCheckedContinuation { continuation in
			waiters.append(continuation)
		}
	}
}
