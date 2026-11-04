import Foundation
import Testing
@testable import PigeonReader

/// The fetch bridge's allow-list, the bridge itself, the on-device fetcher in
/// a real WKWebView (with a stand-in Defuddle and a stub network), and the
/// store's states.
@MainActor
struct YouTubeTranscriptFetchTests {
	// MARK: - Allow-list

	@Test func onlyYouTubeCaptionEndpointsAreAllowed() throws {
		let allowed: [(String, String)] = [
			("POST", "https://www.youtube.com/youtubei/v1/player?prettyPrint=false"),
			("POST", "https://youtube.com/youtubei/v1/next?prettyPrint=false"),
			("GET", "https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en"),
			("GET", "https://m.youtube.com:443/api/timedtext?v=x"),
		]
		for (method, url) in allowed {
			#expect(YouTubeFetchBridgePolicy.isAllowed(method: method, url: try #require(URL(string: url))), "\(method) \(url)")
		}
		let blocked: [(String, String)] = [
			("GET", "http://www.youtube.com/api/timedtext"),
			("GET", "https://www.youtube.com.evil.example/api/timedtext"),
			("GET", "https://evilyoutube.com/api/timedtext"),
			("GET", "https://www.youtube-nocookie.com/api/timedtext"),
			("GET", "https://user:pass@www.youtube.com/api/timedtext"),
			("GET", "https://www.youtube.com:8443/api/timedtext"),
			("GET", "https://www.youtube.com/watch?v=aircAruvnKk"),
			("GET", "https://www.youtube.com/youtubei/v1/player"),
			("POST", "https://www.youtube.com/api/timedtext"),
			("DELETE", "https://www.youtube.com/youtubei/v1/player"),
			("GET", "https://pigeon.hanscho.com/api/v1/sync"),
			("GET", "https://googlevideo.com/api/timedtext"),
		]
		for (method, url) in blocked {
			#expect(YouTubeFetchBridgePolicy.isAllowed(method: method, url: try #require(URL(string: url))) == false, "\(method) \(url)")
		}
	}

	@Test func bridgedRequestsCarryOnlyTheAgentLanguageAndJSONType() throws {
		let request = try #require(YouTubeFetchBridgePolicy.request(from: [
			"url": "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
			"method": "post",
			"headers": [
				"Content-Type": "application/json", "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
				"Accept-Language": "en", "Cookie": "SID=secret", "Authorization": "Bearer x", "X-Goog-Visitor-Id": "y",
			],
			"body": #"{"videoId":"aircAruvnKk"}"#,
		]))
		#expect(request.httpMethod == "POST")
		#expect(request.httpShouldHandleCookies == false)
		#expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
		#expect(request.value(forHTTPHeaderField: "User-Agent")?.hasPrefix("com.google.android.youtube/") == true)
		#expect(request.value(forHTTPHeaderField: "Accept-Language") == "en")
		#expect(request.value(forHTTPHeaderField: "Cookie") == nil)
		#expect(request.value(forHTTPHeaderField: "Authorization") == nil)
		#expect(request.value(forHTTPHeaderField: "X-Goog-Visitor-Id") == nil)
		#expect(request.httpBody == Data(#"{"videoId":"aircAruvnKk"}"#.utf8))

		// An odd agent is dropped rather than forwarded.
		let plain = try #require(YouTubeFetchBridgePolicy.request(from: [
			"url": "https://www.youtube.com/api/timedtext?v=x", "method": "GET", "headers": ["User-Agent": "curl/8\r\nX: y"],
		]))
		#expect(plain.value(forHTTPHeaderField: "User-Agent") == nil)
		// Oversized bodies, GET bodies and POSTs without one are refused.
		let base: [String: Any] = ["url": "https://www.youtube.com/youtubei/v1/next", "method": "POST"]
		#expect(YouTubeFetchBridgePolicy.request(from: base) == nil)
		#expect(YouTubeFetchBridgePolicy.request(from: base.merging(["body": String(repeating: "x", count: 16_385)]) { $1 }) == nil)
		#expect(YouTubeFetchBridgePolicy.request(from: ["url": "https://www.youtube.com/api/timedtext", "method": "GET", "body": "x"]) == nil)
		#expect(YouTubeFetchBridgePolicy.request(from: ["url": "https://example.com/api/timedtext", "method": "GET"]) == nil)
	}

	// MARK: - Bridge

	@Test func theBridgeRepliesOnceToEveryMessage() async throws {
		let transport = StubTransport(body: "<transcript/>")
		let bridge = YouTubeFetchBridge(transport: transport)
		let replies = ReplyLog()

		bridge.handle(["id": 1, "url": "https://www.youtube.com/api/timedtext?v=x", "method": "GET"], reply: replies.record(1))
		bridge.handle(["id": 2, "url": "https://evil.example/api/timedtext", "method": "GET"], reply: replies.record(2))
		bridge.handle("not a dictionary", reply: replies.record(3))
		try await waitUntil { replies.count == 3 }

		#expect(replies[1]?.error == nil)
		#expect((replies[1]?.value as? [String: Any])?["status"] as? Int == 200)
		#expect((replies[1]?.value as? [String: Any])?["body"] as? String == "<transcript/>")
		#expect(replies[2]?.error == "Blocked")
		#expect(replies[3]?.error != nil)
		#expect(await transport.requests.map(\.url?.host) == ["www.youtube.com"], "a blocked request never reaches the network")

		// After the run ends, nothing new goes out and in-flight requests still answer.
		let slow = StubTransport(body: "x", delay: .seconds(30))
		let closing = YouTubeFetchBridge(transport: slow)
		closing.handle(["id": 1, "url": "https://www.youtube.com/api/timedtext?v=x", "method": "GET"], reply: replies.record(10))
		try await waitUntil { await slow.requests.count == 1 }
		closing.close()
		closing.handle(["id": 2, "url": "https://www.youtube.com/api/timedtext?v=x", "method": "GET"], reply: replies.record(11))
		try await waitUntil { replies.count == 5 }
		#expect(replies[10]?.error == "The transcript request ended")
		#expect(replies[11]?.error == "The transcript request ended")
	}

	@Test func theBridgeCapsRequestsPerRun() async throws {
		let bridge = YouTubeFetchBridge(transport: StubTransport(body: "x"))
		let replies = ReplyLog()
		// One at a time, as Defuddle mostly asks; concurrency is capped by bytes (below).
		for id in 1...(YouTubeFetchBridge.maximumRequests + 1) {
			bridge.handle(["id": id, "url": "https://www.youtube.com/api/timedtext?v=x", "method": "GET"], reply: replies.record(id))
			try await waitUntil { replies.count == id }
		}
		#expect(replies[YouTubeFetchBridge.maximumRequests + 1]?.error == "Too many requests")
	}

	// MARK: - Fetcher in a real web view

	/// Stands in for Defuddle: one allowed caption request, one blocked one.
	private static let fakeDefuddle = """
	var Defuddle = function(doc, options) { this.options = options; };
	Defuddle.prototype.parseAsync = async function() {
		if (this.options.url !== 'https://www.youtube.com/watch?v=aircAruvnKk' || this.options.useAsync !== true) throw new Error('bad options');
		const response = await this.options.fetch('https://www.youtube.com/api/timedtext?v=aircAruvnKk', { headers: { 'User-Agent': 'Mozilla/5.0', Cookie: 'x' }, signal: AbortSignal.timeout(4000) });
		const text = await response.text();
		let blocked = false;
		try { await this.options.fetch('https://evil.example/api/timedtext'); } catch (error) { blocked = true; }
		return { variables: { transcript: text + (blocked ? '' : '\\n**0:09** · the blocked request went out') }, language: 'en' };
	};
	"""

	@Test func theFetcherRunsDefuddleOverTheBridgeAndParsesItsText() async throws {
		let transport = StubTransport(body: "### Opening\n**0:01** · Hello from the bridge.\n**0:04** · Second line.")
		let fetcher = YouTubeTranscriptFetcher(transport: transport, defuddleSource: { Self.fakeDefuddle }, timeout: .seconds(10))

		let transcript = try await fetcher.fetchTranscript(videoID: "aircAruvnKk")

		#expect(transcript == YouTubeTranscript(
			language: "en",
			segments: [.init(start: 1, duration: 3, text: "Hello from the bridge."), .init(start: 4, text: "Second line.")],
			chapters: [.init(start: 1, title: "Opening")],
		))
		let requests = await transport.requests
		#expect(requests.map(\.url?.absoluteString) == ["https://www.youtube.com/api/timedtext?v=aircAruvnKk"])
		#expect(requests.first?.value(forHTTPHeaderField: "User-Agent") == "Mozilla/5.0")
		#expect(requests.first?.value(forHTTPHeaderField: "Cookie") == nil)
	}

	@Test func aRunThatNeverAnswersEndsAtTheDeadline() async throws {
		let hanging = "var Defuddle = function() {}; Defuddle.prototype.parseAsync = function() { return new Promise(function() {}); };"
		let fetcher = YouTubeTranscriptFetcher(transport: StubTransport(body: ""), defuddleSource: { hanging }, timeout: .seconds(1))
		let started = ContinuousClock.now

		await #expect(throws: YouTubeTranscriptError.timedOut) {
			try await fetcher.fetchTranscript(videoID: "aircAruvnKk")
		}
		#expect(ContinuousClock.now - started < .seconds(5))
	}

	@Test func noTranscriptAndBadInputFailCleanly() async throws {
		let empty = "var Defuddle = function() {}; Defuddle.prototype.parseAsync = async function() { return { variables: {} }; };"
		let fetcher = YouTubeTranscriptFetcher(transport: StubTransport(body: ""), defuddleSource: { empty }, timeout: .seconds(5))
		await #expect(throws: YouTubeTranscriptError.noTranscript) { try await fetcher.fetchTranscript(videoID: "aircAruvnKk") }
		await #expect(throws: YouTubeTranscriptError.notAVideo) { try await fetcher.fetchTranscript(videoID: "bad") }
		let missing = YouTubeTranscriptFetcher(transport: StubTransport(body: ""), defuddleSource: { nil })
		await #expect(throws: YouTubeTranscriptError.unavailable) { try await missing.fetchTranscript(videoID: "aircAruvnKk") }
	}

	@Test func cancellingAFetchEndsItPromptly() async throws {
		let hanging = "var Defuddle = function() {}; Defuddle.prototype.parseAsync = function() { return new Promise(function() {}); };"
		let fetcher = YouTubeTranscriptFetcher(transport: StubTransport(body: ""), defuddleSource: { hanging }, timeout: .seconds(20))
		let task = Task { try await fetcher.fetchTranscript(videoID: "aircAruvnKk") }
		try await Task.sleep(for: .milliseconds(500))
		let started = ContinuousClock.now
		task.cancel()
		await #expect(throws: CancellationError.self) { try await task.value }
		#expect(ContinuousClock.now - started < .seconds(3))
	}

	@Test func theBundledDefuddleHasTheYouTubeExtractorThisBridgeExpects() throws {
		let source = try #require(ReaderViewExtractor.bundledDefuddleSource())
		#expect(source.contains("youtubei/v1/player"))
		#expect(source.contains("parseAsync"))
	}

	// MARK: - Store

	private static let video = YouTubeVideo(url: URL(string: "https://www.youtube.com/watch?v=aircAruvnKk"))!

	private static func article(hasTranscript: Bool? = nil) -> Recommendation {
		var article = PreviewData.articles.first { $0.id == "preview-youtube" }!
		article.hasTranscript = hasTranscript
		return article
	}

	@Test func gettingATranscriptShowsItAndUploadsItInTheBackground() async throws {
		let fetcher = StubFetcher(results: [.success(PreviewTranscriptFetcher.transcript)])
		let api = StubTranscriptAPI()
		let store = YouTubeTranscriptStore(fetcher: fetcher, uploadRetryDelays: [])
		store.apiProvider = { api }
		let article = Self.article()

		#expect(store.phase(for: article) == .idle)
		store.request(article, video: Self.video)
		#expect(store.phase(for: article) == .fetching)
		store.request(article, video: Self.video)
		try await waitUntil { store.phase(for: article) == .ready(YouTubeTranscriptLayout(PreviewTranscriptFetcher.transcript)) }
		try await waitUntil { await api.uploads.count == 1 }
		#expect(fetcher.calls == 1, "a second tap while fetching starts nothing")
		#expect(await api.uploads.first?.itemID == article.readerId)
		#expect(await api.reads == 1, "it asks the server first in case another device stored one")
	}

	@Test func aFailureStaysPutUntilTryAgain() async throws {
		let fetcher = StubFetcher(results: [.failure(YouTubeTranscriptError.timedOut), .success(PreviewTranscriptFetcher.transcript)])
		let store = YouTubeTranscriptStore(fetcher: fetcher, uploadRetryDelays: [])
		store.apiProvider = { StubTranscriptAPI() }
		let article = Self.article()

		store.request(article, video: Self.video)
		try await waitUntil { store.phase(for: article) == .failed("YouTube took too long to answer.") }
		try await Task.sleep(for: .milliseconds(300))
		#expect(fetcher.calls == 1, "no automatic retry loop")
		#expect(store.phase(for: article) == .failed("YouTube took too long to answer."))

		store.request(article, video: Self.video)
		try await waitUntil { store.phase(for: article) == .ready(YouTubeTranscriptLayout(PreviewTranscriptFetcher.transcript)) }
		#expect(fetcher.calls == 2)
	}

	@Test func aKnownTranscriptLoadsWithoutTheButtonAndFailsWithoutLooping() async throws {
		let stored = StoredYouTubeTranscript(itemId: "x", updatedAt: nil, transcript: PreviewTranscriptFetcher.transcript)
		let api = StubTranscriptAPI(stored: .success(stored))
		let store = YouTubeTranscriptStore(fetcher: StubFetcher(results: []), uploadRetryDelays: [])
		store.apiProvider = { api }
		let article = Self.article(hasTranscript: true)

		#expect(store.phase(for: article) == .checking)
		store.open(article)
		try await waitUntil { store.phase(for: article) == .ready(YouTubeTranscriptLayout(PreviewTranscriptFetcher.transcript)) }

		let failing = StubTranscriptAPI(stored: .failure(PigeonError.server(statusCode: 503, message: "")))
		let failingStore = YouTubeTranscriptStore(fetcher: StubFetcher(results: []), uploadRetryDelays: [])
		failingStore.apiProvider = { failing }
		failingStore.open(article)
		try await waitUntil { failingStore.phase(for: article) == .failed(YouTubeTranscriptStore.loadFailureMessage) }
		failingStore.open(article)
		try await Task.sleep(for: .milliseconds(200))
		#expect(await failing.reads == 1, "opening again does not reload a failure by itself")

		// A stale flag (nothing stored) falls back to the button.
		let stale = YouTubeTranscriptStore(fetcher: StubFetcher(results: []), uploadRetryDelays: [])
		let empty = StubTranscriptAPI(stored: .success(nil))
		stale.apiProvider = { empty }
		stale.open(article)
		try await waitUntil { stale.phase(for: article) == .idle }
	}

	@Test func aNewerFormatOnTheServerIsNeverOverwritten() async throws {
		let newer = StubTranscriptAPI(stored: .failure(YouTubeTranscriptFormatError.unsupportedVersion(2)))
		let fetcher = StubFetcher(results: [.success(PreviewTranscriptFetcher.transcript)])
		let store = YouTubeTranscriptStore(fetcher: fetcher, uploadRetryDelays: [])
		store.apiProvider = { newer }

		// Opening a known transcript in a newer format asks for an update.
		store.open(Self.article(hasTranscript: true))
		try await waitUntil { store.phase(for: Self.article()) == .needsUpdate }
		store.request(Self.article(), video: Self.video)
		#expect(store.phase(for: Self.article()) == .needsUpdate, "no fetch from this state")

		// Get Transcript on an item whose flag had not synced yet: still no fetch, no upload.
		let other = YouTubeTranscriptStore(fetcher: fetcher, uploadRetryDelays: [])
		other.apiProvider = { newer }
		other.request(Self.article(), video: Self.video)
		try await waitUntil { other.phase(for: Self.article()) == .needsUpdate }
		try await Task.sleep(for: .milliseconds(100))
		#expect(fetcher.calls == 0)
		#expect(await newer.uploads.isEmpty)
	}

	@Test func aReplacedUploadDoesNotClearTheNewOne() async throws {
		// The first upload hangs until cancelled; the second replaces it.
		let api = StubTranscriptAPI(uploadDelay: .seconds(30))
		let first = PreviewTranscriptFetcher.transcript
		var second = first
		second.segments[0].text = "Changed."
		let store = YouTubeTranscriptStore(fetcher: StubFetcher(results: [.success(first), .success(second)]), uploadRetryDelays: [])
		store.apiProvider = { api }
		let article = Self.article()

		store.request(article, video: Self.video)
		try await waitUntil { await api.uploads.count == 1 }
		// Evicted from memory, then fetched again: the second upload replaces the first.
		store.evict(key: YouTubeTranscriptStore.key(for: article))
		store.request(article, video: Self.video)
		try await waitUntil { await api.uploads.count == 2 }
		// The cancelled first task has finished by now; the second is still in flight.
		try await Task.sleep(for: .milliseconds(200))
		#expect(store.uploads.count == 1, "the cancelled task must not remove its replacement")
	}

	@Test func offlineFetchesSayYouAreOffline() async throws {
		#expect(YouTubeTranscriptStore.fetchFailureMessage(for: YouTubeTranscriptError.offline) == YouTubeTranscriptStore.offlineMessage)
		// Defuddle swallows the failed request and reports nothing; the bridge saw why.
		let swallowing = """
		var Defuddle = function(doc, options) { this.options = options; };
		Defuddle.prototype.parseAsync = async function() {
			try { await this.options.fetch('https://www.youtube.com/api/timedtext?v=x'); } catch (error) {}
			return { variables: {} };
		};
		"""
		let offline = YouTubeTranscriptFetcher(transport: StubTransport(error: URLError(.notConnectedToInternet)), defuddleSource: { swallowing }, timeout: .seconds(5))
		await #expect(throws: YouTubeTranscriptError.offline) { try await offline.fetchTranscript(videoID: "aircAruvnKk") }
		// An answered request (e.g. a 404) with no captions is still "no transcript".
		let online = YouTubeTranscriptFetcher(transport: StubTransport(body: ""), defuddleSource: { swallowing }, timeout: .seconds(5))
		await #expect(throws: YouTubeTranscriptError.noTranscript) { try await online.fetchTranscript(videoID: "aircAruvnKk") }
	}

	@Test func concurrentRequestsShareTheRunsByteBudget() async throws {
		let transport = StubTransport(body: "small", delay: .seconds(30))
		let bridge = YouTubeFetchBridge(transport: transport)
		let replies = ReplyLog()
		let perRun = YouTubeFetchBridge.maximumTotalBytes / YouTubeFetchBridge.maximumResponseBytes
		for id in 1...(perRun + 1) {
			bridge.handle(["id": id, "url": "https://www.youtube.com/api/timedtext?v=x", "method": "GET"], reply: replies.record(id))
		}
		try await waitUntil { await transport.requests.count == perRun && replies.count == 1 }
		#expect(replies[perRun + 1]?.error == "Too many bytes", "in-flight requests have reserved the whole budget")
		#expect(await transport.maximumBytes == Array(repeating: YouTubeFetchBridge.maximumResponseBytes, count: perRun))
		#expect(bridge.remainingBytes == 0)
		bridge.close()
		try await waitUntil { replies.count == perRun + 1 }
		#expect(bridge.remainingBytes == YouTubeFetchBridge.maximumTotalBytes, "cancelled requests give their reservation back")
	}

	@Test func finishedRequestsKeepOnlyWhatArrived() async throws {
		let bridge = YouTubeFetchBridge(transport: StubTransport(body: "12345"))
		let replies = ReplyLog()
		bridge.handle(["id": 1, "url": "https://www.youtube.com/api/timedtext?v=x", "method": "GET"], reply: replies.record(1))
		try await waitUntil { replies.count == 1 }
		#expect(bridge.remainingBytes == YouTubeFetchBridge.maximumTotalBytes - 5)
	}

	@Test func uploadsRetryOnlyTransientFailures() {
		#expect(YouTubeTranscriptStore.shouldRetryUpload(after: PigeonError.server(statusCode: 503, message: "")))
		#expect(YouTubeTranscriptStore.shouldRetryUpload(after: PigeonError.server(statusCode: 429, message: "")))
		#expect(YouTubeTranscriptStore.shouldRetryUpload(after: URLError(.notConnectedToInternet)))
		for status in [400, 401, 404, 413, 422] {
			#expect(YouTubeTranscriptStore.shouldRetryUpload(after: PigeonError.server(statusCode: status, message: "")) == false, "\(status)")
		}
		#expect(YouTubeTranscriptStore.shouldRetryUpload(after: CancellationError()) == false)
		#expect(PigeonError.server(statusCode: 413, message: #"{"error":"Too large","code":"transcript_too_large"}"#).serverCode == "transcript_too_large")
	}

	@Test func aTooLargeUploadIsNotRetriedButAnOutageIs() async throws {
		let tooLarge = StubTranscriptAPI(uploadFailure: PigeonError.server(statusCode: 413, message: #"{"code":"transcript_too_large"}"#))
		let store = YouTubeTranscriptStore(fetcher: StubFetcher(results: [.success(PreviewTranscriptFetcher.transcript)]), uploadRetryDelays: [.zero, .zero])
		store.apiProvider = { tooLarge }
		store.request(Self.article(), video: Self.video)
		try await waitUntil { await tooLarge.uploads.count == 1 }
		try await waitUntil { store.uploads.isEmpty }
		try await Task.sleep(for: .milliseconds(100))
		#expect(await tooLarge.uploads.count == 1)

		let outage = StubTranscriptAPI(uploadFailure: PigeonError.server(statusCode: 503, message: ""))
		let retrying = YouTubeTranscriptStore(fetcher: StubFetcher(results: [.success(PreviewTranscriptFetcher.transcript)]), uploadRetryDelays: [.zero, .zero])
		retrying.apiProvider = { outage }
		retrying.request(Self.article(), video: Self.video)
		try await waitUntil { await outage.uploads.count == 3 }
		try await waitUntil { retrying.uploads.isEmpty }
		#expect(await outage.uploads.count == 3, "two retries, then it stops")
	}

	@Test func resetDropsStateAndIgnoresLateResults() async throws {
		let fetcher = StubFetcher(results: [.success(PreviewTranscriptFetcher.transcript)], delay: .milliseconds(200))
		let store = YouTubeTranscriptStore(fetcher: fetcher, uploadRetryDelays: [])
		store.apiProvider = { StubTranscriptAPI() }
		let article = Self.article()
		store.request(article, video: Self.video)
		store.reset()
		#expect(store.phase(for: article) == .idle)
		try await Task.sleep(for: .milliseconds(400))
		#expect(store.phase(for: article) == .idle)
	}
}

// MARK: - Test doubles

private actor StubTransport: YouTubeBridgeTransport {
	private let body: String
	private let delay: Duration?
	private let error: Error?
	private(set) var requests: [URLRequest] = []
	private(set) var maximumBytes: [Int] = []

	init(body: String = "", delay: Duration? = nil, error: Error? = nil) {
		self.body = body
		self.delay = delay
		self.error = error
	}

	func send(_ request: URLRequest, maximumBytes: Int) async throws -> (Data, HTTPURLResponse) {
		requests.append(request)
		self.maximumBytes.append(maximumBytes)
		if let delay { try await Task.sleep(for: delay) }
		if let error { throw error }
		let url = request.url ?? URL(string: "https://www.youtube.com/")!
		return (Data(body.utf8), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/xml"])!)
	}
}

@MainActor
private final class ReplyLog {
	struct Reply {
		let value: Any?
		let error: String?
	}

	private var replies: [Int: Reply] = [:]
	var count: Int { replies.count }

	subscript(id: Int) -> Reply? { replies[id] }

	func record(_ id: Int) -> @MainActor @Sendable (Any?, String?) -> Void {
		{ [weak self] value, error in
			precondition(self?.replies[id] == nil, "message \(id) was answered twice")
			self?.replies[id] = Reply(value: value, error: error)
		}
	}
}

@MainActor
private final class StubFetcher: YouTubeTranscriptFetching {
	private var results: [Result<YouTubeTranscript, Error>]
	private let delay: Duration
	private(set) var calls = 0

	init(results: [Result<YouTubeTranscript, Error>], delay: Duration = .milliseconds(20)) {
		self.results = results
		self.delay = delay
	}

	func fetchTranscript(videoID: String) async throws -> YouTubeTranscript {
		calls += 1
		try await Task.sleep(for: delay)
		guard results.isEmpty == false else { throw YouTubeTranscriptError.unavailable }
		return try results.removeFirst().get()
	}
}

private actor StubTranscriptAPI: YouTubeTranscriptAPI {
	private let stored: Result<StoredYouTubeTranscript?, Error>
	private let uploadFailure: Error?
	private let uploadDelay: Duration?
	private(set) var reads = 0
	private(set) var uploads: [(itemID: String, transcript: YouTubeTranscript)] = []

	init(stored: Result<StoredYouTubeTranscript?, Error> = .success(nil), uploadFailure: Error? = nil, uploadDelay: Duration? = nil) {
		self.stored = stored
		self.uploadFailure = uploadFailure
		self.uploadDelay = uploadDelay
	}

	func transcript(itemID: String) async throws -> StoredYouTubeTranscript? {
		reads += 1
		return try stored.get()
	}

	func uploadTranscript(itemID: String, transcript: YouTubeTranscript) async throws -> YouTubeTranscriptUploadResponse {
		uploads.append((itemID, transcript))
		if let uploadDelay { try await Task.sleep(for: uploadDelay) }
		if let uploadFailure { throw uploadFailure }
		return YouTubeTranscriptUploadResponse(itemId: itemID, updated: true, segmentCount: transcript.segments.count, chapterCount: 0, bytes: 1)
	}
}

@MainActor
private func waitUntil(
	timeout: Duration = .seconds(10),
	_ condition: @MainActor () async -> Bool,
) async throws {
	let deadline = ContinuousClock.now + timeout
	while await condition() == false {
		guard ContinuousClock.now < deadline else {
			Issue.record("Timed out waiting for a condition")
			return
		}
		try await Task.sleep(for: .milliseconds(20))
	}
}
