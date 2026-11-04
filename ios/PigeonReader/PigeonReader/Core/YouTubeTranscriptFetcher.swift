import Foundation
import OSLog
import WebKit

@MainActor
protocol YouTubeTranscriptFetching {
	func fetchTranscript(videoID: String) async throws -> YouTubeTranscript
}

nonisolated enum YouTubeTranscriptError: Error, Equatable, Sendable {
	case notAVideo
	case noTranscript
	case timedOut
	case unavailable
	/// Every request YouTube was sent failed for lack of a connection.
	case offline
}

/// Fetches a transcript on the phone: Defuddle's YouTube extractor runs with
/// `parseAsync()` in an offscreen WKWebView, and its `fetch` is a bridge to
/// URLSession, so the requests leave from the device (not a datacenter) and
/// are not subject to CORS. Only YouTube's caption endpoints are reachable
/// (`YouTubeFetchBridgePolicy`); the page itself has no network access.
@MainActor
final class YouTubeTranscriptFetcher: YouTubeTranscriptFetching {
	static let defaultTimeout: Duration = .seconds(25)

	private let transport: any YouTubeBridgeTransport
	private let defuddleSource: @MainActor () -> String?
	private let timeout: Duration

	init(
		transport: any YouTubeBridgeTransport = URLSessionYouTubeBridgeTransport(),
		defuddleSource: @escaping @MainActor () -> String? = { ReaderViewExtractor.bundledDefuddleSource() },
		timeout: Duration = YouTubeTranscriptFetcher.defaultTimeout,
	) {
		self.transport = transport
		self.defuddleSource = defuddleSource
		self.timeout = timeout
	}

	func fetchTranscript(videoID: String) async throws -> YouTubeTranscript {
		guard YouTubeVideo.isValidVideoID(videoID) else { throw YouTubeTranscriptError.notAVideo }
		guard let source = defuddleSource() else { throw YouTubeTranscriptError.unavailable }
		let run = YouTubeTranscriptRun(transport: transport)
		defer { run.tearDown() }
		let raw: YouTubeTranscriptRun.RawResult
		do {
			raw = try await run.run(defuddleSource: source, videoID: videoID, timeout: timeout)
		} catch where isCancellation(error) == false && run.wasOffline {
			throw YouTubeTranscriptError.offline
		}
		// Defuddle swallows fetch failures and reports no transcript; tell the
		// two apart by what the bridge saw.
		guard let transcript = YouTubeTranscript.parseDefuddle(raw.transcript, language: raw.language) else {
			throw run.wasOffline ? YouTubeTranscriptError.offline : YouTubeTranscriptError.noTranscript
		}
		return transcript
	}
}

/// One extraction: a throwaway web view, its fetch bridge, and a deadline.
/// Every way out (result, script error, deadline, task cancellation) goes
/// through `finish`, which resumes the waiting continuation exactly once and
/// closes the bridge so in-flight requests are cancelled.
@MainActor
final class YouTubeTranscriptRun: NSObject, WKNavigationDelegate {
	nonisolated struct RawResult: Equatable, Sendable {
		let transcript: String?
		let language: String?
	}

	private let webView: WKWebView
	private let bridge: YouTubeFetchBridge
	private var navigationContinuation: CheckedContinuation<Void, Error>?
	private var resultContinuation: CheckedContinuation<RawResult, Error>?
	private var deadlineTask: Task<Void, Never>?
	private var terminalError: Error?

	init(transport: any YouTubeBridgeTransport) {
		bridge = YouTubeFetchBridge(transport: transport)
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .nonPersistent()
		configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
		configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: YouTubeFetchBridge.name)
		webView = WKWebView(frame: .zero, configuration: configuration)
		super.init()
		webView.navigationDelegate = self
		webView.isHidden = true
	}

	func run(defuddleSource: String, videoID: String, timeout: Duration) async throws -> RawResult {
		// The page enforces the same deadline itself; this one also covers loading.
		deadlineTask = Task { [weak self] in
			try? await Task.sleep(for: timeout + .seconds(2))
			guard Task.isCancelled == false else { return }
			self?.fail(YouTubeTranscriptError.timedOut)
		}
		defer {
			deadlineTask?.cancel()
			deadlineTask = nil
		}
		return try await withTaskCancellationHandler {
			try await loadShell()
			try await evaluate(defuddleSource + "\n;window.__PigeonDefuddle = Defuddle;\nnull;")
			return try await extract(videoID: videoID, timeoutMilliseconds: Int(timeout.components.seconds) * 1000)
		} onCancel: {
			Task { @MainActor [weak self] in self?.fail(CancellationError()) }
		}
	}

	/// True when requests failed for lack of a connection and none got an answer.
	var wasOffline: Bool { bridge.wasOffline }

	func tearDown() {
		fail(CancellationError())
		bridge.close()
		webView.stopLoading()
		webView.navigationDelegate = nil
		webView.configuration.userContentController.removeAllScriptMessageHandlers()
	}

	private func loadShell() async throws {
		try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
			if let terminalError {
				continuation.resume(throwing: terminalError)
				return
			}
			navigationContinuation = continuation
			// No network from the page: every byte comes through the bridge.
			webView.loadHTMLString(
				"<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'; connect-src 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; form-action 'none'\"></head><body></body></html>",
				baseURL: URL(string: "https://pigeon.invalid/"),
			)
		}
	}

	private func evaluate(_ script: String) async throws {
		if let terminalError { throw terminalError }
		do {
			_ = try await webView.evaluateJavaScript(script)
		} catch {
			if let terminalError { throw terminalError }
			throw YouTubeTranscriptError.unavailable
		}
		if let terminalError { throw terminalError }
	}

	private func extract(videoID: String, timeoutMilliseconds: Int) async throws -> RawResult {
		try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<RawResult, Error>) in
			if let terminalError {
				continuation.resume(throwing: terminalError)
				return
			}
			resultContinuation = continuation
			webView.callAsyncJavaScript(
				Self.extractionScript,
				arguments: ["videoId": videoID, "timeoutMs": timeoutMilliseconds],
				in: nil,
				in: .page,
			) { [weak self] result in
				switch result {
				case .success(let value):
					self?.complete(with: Self.rawResult(from: value))
				case .failure:
					self?.complete(with: .failure(YouTubeTranscriptError.unavailable))
				}
			}
		}
	}

	nonisolated static func rawResult(from value: Any?) -> Result<RawResult, Error> {
		guard let payload = value as? [String: Any] else { return .failure(YouTubeTranscriptError.unavailable) }
		if let error = payload["error"] as? String {
			return .failure(error == "timeout" ? YouTubeTranscriptError.timedOut : YouTubeTranscriptError.unavailable)
		}
		return .success(RawResult(transcript: payload["transcript"] as? String, language: payload["language"] as? String))
	}

	private func complete(with result: Result<RawResult, Error>) {
		guard let continuation = resultContinuation else { return }
		resultContinuation = nil
		continuation.resume(with: result)
	}

	private func fail(_ error: Error) {
		if terminalError == nil {
			terminalError = error
		}
		bridge.close()
		if let continuation = navigationContinuation {
			navigationContinuation = nil
			continuation.resume(throwing: error)
		}
		complete(with: .failure(error))
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		guard let continuation = navigationContinuation else { return }
		navigationContinuation = nil
		continuation.resume()
	}

	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
		fail(YouTubeTranscriptError.unavailable)
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		fail(YouTubeTranscriptError.unavailable)
	}

	/// The body of an async function: `videoId` and `timeoutMs` are its arguments.
	/// Mirrors `fetchYouTubeTranscript` in src/browser-transcript.ts: an empty
	/// document for the watch URL, so every byte comes through `fetch`; each
	/// request carries this run's AbortSignal, and the run has one deadline.
	static let extractionScript = """
	const Defuddle = window.__PigeonDefuddle;
	if (typeof Defuddle !== 'function') return { error: 'unavailable' };
	const bridge = window.webkit.messageHandlers.\(YouTubeFetchBridge.name);
	const controller = new AbortController();
	let nextId = 0;
	const abortError = () => new DOMException('The transcript request ended', 'AbortError');
	const bridgedFetch = (input, init) => {
		init = init || {};
		const url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
		const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
		if (signal.aborted) return Promise.reject(abortError());
		const headers = {};
		const source = init.headers || {};
		if (typeof source.forEach === 'function' && !Array.isArray(source)) source.forEach((value, name) => { headers[name] = String(value); });
		else for (const [name, value] of Object.entries(source)) headers[name] = String(value);
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			const onAbort = () => { bridge.postMessage({ cancel: id }).catch(() => {}); reject(abortError()); };
			signal.addEventListener('abort', onAbort, { once: true });
			bridge.postMessage({ id, url, method: String(init.method || 'GET').toUpperCase(), headers, body: typeof init.body === 'string' ? init.body : null }).then((reply) => {
				signal.removeEventListener('abort', onAbort);
				if (signal.aborted) return;
				const status = Math.min(599, Math.max(200, Number(reply && reply.status) || 502));
				const nullBody = status === 204 || status === 205 || status === 304;
				resolve(new Response(nullBody ? null : String(reply.body || ''), { status, headers: reply.contentType ? { 'Content-Type': reply.contentType } : {} }));
			}, (error) => {
				signal.removeEventListener('abort', onAbort);
				reject(new TypeError(String((error && error.message) || error || 'Network request failed')));
			});
		});
	};
	let timer = null;
	try {
		const page = document.implementation.createHTMLDocument('');
		const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); });
		const result = await Promise.race([
			new Defuddle(page, { url: 'https://www.youtube.com/watch?v=' + videoId, fetch: bridgedFetch, useAsync: true }).parseAsync(),
			deadline,
		]);
		if (result && result.timedOut === true) return { error: 'timeout' };
		const variables = result && result.variables;
		return {
			transcript: variables && typeof variables.transcript === 'string' ? variables.transcript : null,
			language: result && typeof result.language === 'string' ? result.language : null,
		};
	} catch (error) {
		return { error: 'failed' };
	} finally {
		if (timer !== null) clearTimeout(timer);
		controller.abort();
	}
	"""
}

// MARK: - Fetch bridge

/// The page's `fetch`: each call posts a message and awaits the reply. A
/// request outside `YouTubeFetchBridgePolicy` is refused before any network
/// work. Every message gets exactly one reply.
@MainActor
final class YouTubeFetchBridge: NSObject, WKScriptMessageHandlerWithReply {
	static let name = "pigeonFetch"
	/// Defuddle makes at most five requests (three player clients, captions, chapters).
	static let maximumRequests = 12
	static let maximumResponseBytes = 4_000_000
	static let maximumTotalBytes = 12_000_000

	private static let logger = Logger(subsystem: "com.hans.pigeon.reader", category: "YouTubeTranscript")

	private let transport: any YouTubeBridgeTransport
	private var tasks: [Int: Task<Void, Never>] = [:]
	private var requestCount = 0
	/// Bytes received plus the full per-response allowance of every request in
	/// flight, so concurrent requests cannot together exceed the run's total.
	private var committedBytes = 0
	private var answeredCount = 0
	private var connectivityFailures = 0
	private(set) var isClosed = false

	var remainingBytes: Int { Self.maximumTotalBytes - committedBytes }
	var wasOffline: Bool { connectivityFailures > 0 && answeredCount == 0 }

	init(transport: any YouTubeBridgeTransport) {
		self.transport = transport
		super.init()
	}

	func userContentController(
		_ userContentController: WKUserContentController,
		didReceive message: WKScriptMessage,
		replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void,
	) {
		handle(message.body, reply: replyHandler)
	}

	/// The message handler without WebKit types, for tests.
	func handle(_ body: Any, reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
		guard isClosed == false, let message = body as? [String: Any] else {
			reply(nil, "The transcript request ended")
			return
		}
		if let cancelID = (message["cancel"] as? NSNumber)?.intValue {
			tasks.removeValue(forKey: cancelID)?.cancel()
			reply(nil, nil)
			return
		}
		guard let id = (message["id"] as? NSNumber)?.intValue, tasks[id] == nil else {
			reply(nil, "Invalid request")
			return
		}
		guard requestCount < Self.maximumRequests else {
			reply(nil, "Too many requests")
			return
		}
		guard let request = YouTubeFetchBridgePolicy.request(from: message) else {
			Self.logger.info("Blocked transcript request to \(String(describing: message["url"] as? String), privacy: .public)")
			reply(nil, "Blocked")
			return
		}
		let budget = min(Self.maximumResponseBytes, remainingBytes)
		guard budget > 0 else {
			reply(nil, "Too many bytes")
			return
		}
		requestCount += 1
		committedBytes += budget
		let transport = transport
		tasks[id] = Task { [weak self] in
			var answer: [String: Any]?
			var failure: String?
			var used = 0
			do {
				let (data, response) = try await transport.send(request, maximumBytes: budget)
				try Task.checkCancellation()
				used = data.count
				answer = [
					"status": response.statusCode,
					"body": String(decoding: data, as: UTF8.self),
					"contentType": response.mimeType ?? "",
				]
			} catch {
				failure = isCancellation(error) ? "The transcript request ended" : "Network request failed"
				if isCancellation(error) == false, isConnectivityFailure(error) {
					self?.connectivityFailures += 1
				}
			}
			if let self {
				// Keep what arrived; give back the rest of the reservation.
				self.committedBytes -= budget - used
				if answer != nil { self.answeredCount += 1 }
				self.tasks[id] = nil
			}
			reply(answer, answer == nil ? failure : nil)
		}
	}

	/// Cancels in-flight requests (each still replies once) and refuses new ones.
	func close() {
		guard isClosed == false else { return }
		isClosed = true
		for task in tasks.values {
			task.cancel()
		}
	}
}

/// What the page may ask the phone to fetch: the same narrow set as the
/// Worker's web proxy (`/api/v1/browser/youtube-proxy`). HTTPS on
/// youtube.com or a subdomain, default port, no credentials, and only the
/// InnerTube player/next calls and the caption track.
nonisolated enum YouTubeFetchBridgePolicy {
	static let maximumRequestBodyBytes = 16_384

	private static let allowedRoutes: Set<String> = [
		"POST /youtubei/v1/player",
		"POST /youtubei/v1/next",
		"GET /api/timedtext",
	]

	static func isAllowedHost(_ url: URL) -> Bool {
		guard url.scheme?.lowercased() == "https",
			let host = url.host()?.lowercased(), host.isEmpty == false,
			url.user == nil,
			url.password == nil,
			url.port == nil || url.port == 443 else { return false }
		return host == "youtube.com" || host.hasSuffix(".youtube.com")
	}

	static func isAllowed(method: String, url: URL) -> Bool {
		guard isAllowedHost(url) else { return false }
		return allowedRoutes.contains("\(method.uppercased()) \(url.path())")
	}

	static func request(from message: [String: Any]) -> URLRequest? {
		guard let urlString = message["url"] as? String, urlString.utf8.count <= 8_192,
			let url = URL(string: urlString),
			let method = (message["method"] as? String)?.uppercased(),
			isAllowed(method: method, url: url) else { return nil }
		var request = URLRequest(url: url)
		request.httpMethod = method
		request.httpShouldHandleCookies = false
		request.cachePolicy = .reloadIgnoringLocalCacheData
		request.timeoutInterval = 10
		let body = message["body"] as? String
		if method == "POST" {
			guard let body, body.utf8.count <= maximumRequestBodyBytes else { return nil }
			request.httpBody = Data(body.utf8)
		} else if let body, body.isEmpty == false {
			return nil
		}
		let headers = message["headers"] as? [String: Any] ?? [:]
		for (name, rawValue) in headers {
			guard let value = rawValue as? String else { continue }
			switch name.lowercased() {
			case "user-agent" where isAllowedUserAgent(value):
				request.setValue(value, forHTTPHeaderField: "User-Agent")
			case "accept-language" where value.wholeMatch(of: /[A-Za-z0-9,;=. *-]{1,64}/) != nil:
				request.setValue(value, forHTTPHeaderField: "Accept-Language")
			case "content-type" where method == "POST" && value.lowercased().hasPrefix("application/json"):
				request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			default:
				// Cookies, credentials and anything else stay behind.
				continue
			}
		}
		return request
	}

	private static func isAllowedUserAgent(_ value: String) -> Bool {
		guard value.utf8.count <= 256, value.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value < 0x7F }) else { return false }
		return value.hasPrefix("Mozilla/5.0") || value.hasPrefix("com.google.android.youtube/") || value.hasPrefix("com.google.ios.youtube/")
	}
}

// MARK: - Transport

nonisolated protocol YouTubeBridgeTransport: Sendable {
	/// The response for `request`, never following redirects; throws when the
	/// body would exceed `maximumBytes`.
	func send(_ request: URLRequest, maximumBytes: Int) async throws -> (Data, HTTPURLResponse)
}

nonisolated struct URLSessionYouTubeBridgeTransport: YouTubeBridgeTransport {
	private static let session: URLSession = {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.httpCookieStorage = nil
		configuration.httpShouldSetCookies = false
		configuration.httpCookieAcceptPolicy = .never
		configuration.urlCache = nil
		configuration.urlCredentialStorage = nil
		configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
		configuration.timeoutIntervalForRequest = 10
		configuration.timeoutIntervalForResource = 20
		return URLSession(configuration: configuration, delegate: RedirectRefusingDelegate(), delegateQueue: nil)
	}()

	func send(_ request: URLRequest, maximumBytes: Int) async throws -> (Data, HTTPURLResponse) {
		let (bytes, response) = try await Self.session.bytes(for: request)
		guard let httpResponse = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
		if httpResponse.expectedContentLength > Int64(maximumBytes) {
			bytes.task.cancel()
			throw URLError(.dataLengthExceedsMaximum)
		}
		var data = Data()
		data.reserveCapacity(Int(max(0, min(httpResponse.expectedContentLength, Int64(maximumBytes)))))
		for try await byte in bytes {
			data.append(byte)
			if data.count > maximumBytes {
				bytes.task.cancel()
				throw URLError(.dataLengthExceedsMaximum)
			}
		}
		return (data, httpResponse)
	}
}

private nonisolated final class RedirectRefusingDelegate: NSObject, URLSessionTaskDelegate, Sendable {
	func urlSession(
		_ session: URLSession,
		task: URLSessionTask,
		willPerformHTTPRedirection response: HTTPURLResponse,
		newRequest request: URLRequest,
	) async -> URLRequest? {
		nil
	}
}
