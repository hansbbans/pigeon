import Foundation

/// Counts failed extraction attempts per saved item on this device. After
/// `SavedItems.maximumExtractionAttempts` the item is reported as failed.
nonisolated struct SavedExtractionAttemptStore: @unchecked Sendable {
	static let key = "pigeon.saved.extraction-attempts.v1"
	private static let maximumEntries = 500

	let defaults: UserDefaults

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
	}

	func attempts(for itemKey: String) -> Int {
		storage[itemKey] ?? 0
	}

	/// Records one more failed attempt and returns the new total.
	@discardableResult
	func recordFailure(for itemKey: String) -> Int {
		var values = storage
		let count = (values[itemKey] ?? 0) + 1
		values[itemKey] = count
		if values.count > Self.maximumEntries {
			// Oldest entries are not tracked; dropping arbitrary ones only means
			// an old item gets a fresh set of attempts.
			for key in values.keys.prefix(values.count - Self.maximumEntries) where key != itemKey {
				values[key] = nil
			}
		}
		defaults.set(values, forKey: Self.key)
		return count
	}

	func clear(_ itemKey: String) {
		var values = storage
		guard values.removeValue(forKey: itemKey) != nil else { return }
		defaults.set(values, forKey: Self.key)
	}

	private var storage: [String: Int] {
		defaults.dictionary(forKey: Self.key) as? [String: Int] ?? [:]
	}
}

/// The calls the coordinator makes to Pigeon; `PigeonAPIClient` in the app.
@MainActor
protocol SavedContentUploading {
	func uploadSavedContent(id: String, content: SavedItemContent) async throws -> SavedItemResponse
	func reportSavedExtractionFailure(id: String) async throws -> SavedItemResponse
}

extension PigeonAPIClient: SavedContentUploading {}

/// Extracts saved links in the background: Defuddle in the offscreen web view
/// for pages, YouTube's oEmbed metadata for videos. At most
/// `maximumConcurrent` run at once; rapid saves simply queue.
@MainActor
final class SavedExtractionCoordinator {
	struct Target: Equatable, Sendable {
		let itemID: String
		let url: URL
		let isVideo: Bool
	}

	enum Outcome: Equatable, Sendable {
		/// The server stored the extraction.
		case done(SavedItemContent)
		/// This attempt failed; the next sweep tries again.
		case willRetry
		/// The last attempt failed and the server now marks the item failed.
		case failed
	}

	private let extractor: any ReaderViewExtracting
	private let httpClient: any HTTPClient
	private let attempts: SavedExtractionAttemptStore
	private let maximumConcurrent: Int
	private let maximumAttempts: Int
	private var queue: [(target: Target, scope: String)] = []
	private var running: [String: Task<Void, Never>] = [:]
	private var generation = UUID()

	/// Receives each finished item on the main actor.
	var onOutcome: (Target, Outcome) -> Void = { _, _ in }
	/// Supplies the uploader for the current session; nil pauses the work.
	var uploaderProvider: () -> (any SavedContentUploading)? = { nil }

	init(
		extractor: any ReaderViewExtracting,
		httpClient: any HTTPClient,
		attempts: SavedExtractionAttemptStore = SavedExtractionAttemptStore(),
		maximumConcurrent: Int = 2,
		maximumAttempts: Int = SavedItems.maximumExtractionAttempts,
	) {
		self.extractor = extractor
		self.httpClient = httpClient
		self.attempts = attempts
		self.maximumConcurrent = max(1, maximumConcurrent)
		self.maximumAttempts = max(1, maximumAttempts)
	}

	var activeItemIDs: Set<String> {
		Set(running.keys).union(queue.map(\.target.itemID))
	}

	func isExtracting(_ itemID: String) -> Bool {
		activeItemIDs.contains(itemID)
	}

	/// Queues items that are not already queued or running. `scope` keeps
	/// attempt counts per account.
	func enqueue(_ targets: [Target], scope: String) {
		for target in targets where isExtracting(target.itemID) == false {
			queue.append((target, scope))
		}
		startNext()
	}

	/// "Try again" on a failed item: a fresh set of attempts, ahead of the sweep.
	func retry(_ target: Target, scope: String) {
		attempts.clear(Self.attemptKey(scope: scope, itemID: target.itemID))
		guard isExtracting(target.itemID) == false else { return }
		queue.insert((target, scope), at: 0)
		startNext()
	}

	/// Moves an item to the front of the queue, keeping its attempt count. A
	/// running item is left alone.
	func prioritize(_ target: Target, scope: String) {
		guard running[target.itemID] == nil else { return }
		queue.removeAll { $0.target.itemID == target.itemID }
		queue.insert((target, scope), at: 0)
		startNext()
	}

	func resetAttempts(itemID: String, scope: String) {
		attempts.clear(Self.attemptKey(scope: scope, itemID: itemID))
	}

	func attemptCount(itemID: String, scope: String) -> Int {
		attempts.attempts(for: Self.attemptKey(scope: scope, itemID: itemID))
	}

	func cancelAll() {
		generation = UUID()
		queue.removeAll()
		for task in running.values { task.cancel() }
		running.removeAll()
	}

	static func attemptKey(scope: String, itemID: String) -> String {
		"\(scope)|\(itemID)"
	}

	private func startNext() {
		while running.count < maximumConcurrent, queue.isEmpty == false {
			let (target, scope) = queue.removeFirst()
			let runGeneration = generation
			running[target.itemID] = Task { [weak self] in
				await self?.process(target, scope: scope, generation: runGeneration)
			}
		}
	}

	private func process(_ target: Target, scope: String, generation runGeneration: UUID) async {
		defer {
			if generation == runGeneration {
				running[target.itemID] = nil
				startNext()
			}
		}
		guard let uploader = uploaderProvider() else { return }
		let key = Self.attemptKey(scope: scope, itemID: target.itemID)
		let outcome: Outcome
		do {
			let content = try await extract(target)
			try Task.checkCancellation()
			let response: SavedItemResponse
			do {
				response = try await uploader.uploadSavedContent(id: target.itemID, content: content)
			} catch {
				// Pigeon was unreachable: not the page's fault, so no attempt is spent.
				guard isCancellation(error) == false, Self.isServerUnavailable(error) == false else { return }
				// Removed on another device; its sync delete is on the way.
				if case PigeonError.server(404, _) = error { return }
				throw error
			}
			guard response.contentTooLarge != true, response.extractionState == .done else {
				throw ReaderViewError.responseTooLarge
			}
			attempts.clear(key)
			outcome = .done(content)
		} catch {
			guard isCancellation(error) == false, Self.isDeviceOffline(error) == false else { return }
			let count = attempts.recordFailure(for: key)
			if count >= maximumAttempts {
				do {
					_ = try await uploader.reportSavedExtractionFailure(id: target.itemID)
				} catch {
					// The report retries with the next sweep; the item stays pending there.
					guard generation == runGeneration else { return }
					onOutcome(target, .willRetry)
					return
				}
				outcome = .failed
			} else {
				outcome = .willRetry
			}
		}
		guard generation == runGeneration, Task.isCancelled == false else { return }
		onOutcome(target, outcome)
	}

	private func extract(_ target: Target) async throws -> SavedItemContent {
		if target.isVideo {
			return await videoContent(for: target.url)
		}
		let document = try await extractor.extract(from: target.url)
		return SavedItemContent(document: document)
	}

	/// Video saves skip text extraction. oEmbed supplies the title, channel and
	/// poster frame; the Worker's cron fills in the duration.
	private func videoContent(for url: URL) async -> SavedItemContent {
		var content = SavedItemContent(mediaKind: "video")
		guard let video = YouTubeVideo(url: url) else { return content }
		var components = URLComponents(string: "https://www.youtube.com/oembed")
		components?.queryItems = [
			URLQueryItem(name: "url", value: video.watchURL.absoluteString),
			URLQueryItem(name: "format", value: "json"),
		]
		guard let endpoint = components?.url else { return content }
		var request = URLRequest(url: endpoint, timeoutInterval: 15)
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		if let (data, response) = try? await httpClient.data(for: request),
			(response as? HTTPURLResponse).map({ 200..<300 ~= $0.statusCode }) == true,
			let metadata = try? JSONDecoder().decode(YouTubeOEmbed.self, from: data) {
			content.title = metadata.title?.trimmingCharacters(in: .whitespacesAndNewlines)
			content.site = metadata.authorName?.trimmingCharacters(in: .whitespacesAndNewlines)
			content.image = metadata.thumbnailURL
		}
		return content
	}

	nonisolated static func isDeviceOffline(_ error: Error) -> Bool {
		let nsError = error as NSError
		guard nsError.domain == NSURLErrorDomain else { return false }
		return [
			NSURLErrorNotConnectedToInternet,
			NSURLErrorNetworkConnectionLost,
			NSURLErrorDataNotAllowed,
			NSURLErrorInternationalRoamingOff,
		].contains(nsError.code)
	}

	nonisolated static func isServerUnavailable(_ error: Error) -> Bool {
		if isConnectivityFailure(error) { return true }
		if case let PigeonError.server(statusCode, _) = error {
			return statusCode >= 500 || statusCode == 429
		}
		if case PigeonError.authenticationFailed = error { return true }
		return false
	}
}

private nonisolated struct YouTubeOEmbed: Decodable {
	let title: String?
	let authorName: String?
	let thumbnailURL: String?

	private enum CodingKeys: String, CodingKey {
		case title
		case authorName = "author_name"
		case thumbnailURL = "thumbnail_url"
	}
}
