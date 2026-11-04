import Foundation
import Observation
import OSLog

/// The Worker calls the transcript store needs; `PigeonAPIClient` in the app.
nonisolated protocol YouTubeTranscriptAPI: Sendable {
	func transcript(itemID: String) async throws -> StoredYouTubeTranscript?
	func uploadTranscript(itemID: String, transcript: YouTubeTranscript) async throws -> YouTubeTranscriptUploadResponse
}

extension PigeonAPIClient: YouTubeTranscriptAPI {}

/// Transcript state per item, shared by every reader view of it.
///
/// `idle` (the Get transcript button) and `failed` (a message and Try again)
/// are terminal: nothing reloads by itself, so a failure can never become a
/// loop or an endless spinner. `checking` and `fetching` always end, because
/// the GET has a request timeout and the fetch has a 25 second deadline.
@MainActor
@Observable
final class YouTubeTranscriptStore {
	enum Phase: Equatable {
		case idle
		/// Reading the copy the server says it holds.
		case checking
		/// Fetching from YouTube on this phone.
		case fetching
		case ready(YouTubeTranscript)
		case failed(String)

		var isLoading: Bool { self == .checking || self == .fetching }
	}

	/// Shown transcripts kept in memory; older ones are read again from the server.
	static let maximumReadyTranscripts = 8

	private(set) var phases: [String: Phase] = [:]

	@ObservationIgnored private let fetcher: any YouTubeTranscriptFetching
	@ObservationIgnored private let uploadRetryDelays: [Duration]
	@ObservationIgnored var apiProvider: @MainActor () -> (any YouTubeTranscriptAPI)? = { nil }
	@ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
	@ObservationIgnored private(set) var uploads: [String: Task<Void, Never>] = [:]
	@ObservationIgnored private var readyOrder: [String] = []
	@ObservationIgnored private var generation = UUID()

	private static let logger = Logger(subsystem: "com.hans.pigeon.reader", category: "YouTubeTranscript")

	init(
		fetcher: any YouTubeTranscriptFetching = YouTubeTranscriptFetcher(),
		uploadRetryDelays: [Duration] = [.seconds(3), .seconds(15)],
	) {
		self.fetcher = fetcher
		self.uploadRetryDelays = uploadRetryDelays
	}

	static func key(for article: Recommendation) -> String {
		article.readerId.isEmpty ? article.id : article.readerId
	}

	/// What the view shows before `open` has run: a known transcript loads, anything else offers the button.
	func phase(for article: Recommendation) -> Phase {
		phases[Self.key(for: article)] ?? (article.hasTranscript == true ? .checking : .idle)
	}

	/// Called when a video is shown. Loads the stored transcript once when the
	/// server has one; otherwise leaves the button.
	func open(_ article: Recommendation) {
		let key = Self.key(for: article)
		guard phases[key] == nil, article.hasTranscript == true else { return }
		setPhase(.checking, for: key)
		let generation = generation
		tasks[key] = Task { [weak self] in
			await self?.loadStored(key: key, generation: generation)
		}
	}

	/// The Get transcript button and Try again: the server's copy if another
	/// device stored one meanwhile, otherwise a fetch on this phone, shown at
	/// once and uploaded in the background.
	func request(_ article: Recommendation, video: YouTubeVideo) {
		let key = Self.key(for: article)
		if let phase = phases[key], phase.isLoading { return }
		if case .ready = phases[key] { return }
		setPhase(.fetching, for: key)
		let generation = generation
		tasks[key] = Task { [weak self] in
			await self?.fetch(key: key, videoID: video.videoID, generation: generation)
		}
	}

	/// Signing out or switching accounts: drop everything and stop work.
	func reset() {
		generation = UUID()
		for task in tasks.values { task.cancel() }
		for task in uploads.values { task.cancel() }
		tasks = [:]
		uploads = [:]
		readyOrder = []
		phases = [:]
	}

	// MARK: - Work

	private func loadStored(key: String, generation: UUID) async {
		defer { finishTask(key: key, generation: generation) }
		guard let api = apiProvider() else {
			setPhase(.failed(Self.loadFailureMessage), for: key, generation: generation)
			return
		}
		do {
			if let stored = try await api.transcript(itemID: key) {
				setPhase(.ready(stored.transcript), for: key, generation: generation)
			} else {
				setPhase(.idle, for: key, generation: generation)
			}
		} catch is YouTubeTranscriptFormatError {
			// A newer format than this build reads: offer a fresh fetch instead.
			setPhase(.idle, for: key, generation: generation)
		} catch where isCancellation(error) {
			setPhase(.idle, for: key, generation: generation)
		} catch {
			Self.logger.error("Loading the stored transcript failed: \(error.localizedDescription, privacy: .public)")
			setPhase(.failed(Self.loadFailureMessage), for: key, generation: generation)
		}
	}

	private func fetch(key: String, videoID: String, generation: UUID) async {
		defer { finishTask(key: key, generation: generation) }
		let api = apiProvider()
		// Another device may have stored it since this item last synced. Any
		// failure here just means fetching it ourselves.
		if let api, let stored = try? await api.transcript(itemID: key) {
			setPhase(.ready(stored.transcript), for: key, generation: generation)
			return
		}
		guard self.generation == generation else { return }
		guard Task.isCancelled == false else {
			setPhase(.idle, for: key, generation: generation)
			return
		}
		do {
			let transcript = try await fetcher.fetchTranscript(videoID: videoID)
			guard self.generation == generation else { return }
			setPhase(.ready(transcript), for: key, generation: generation)
			if let api {
				upload(transcript, key: key, api: api, generation: generation)
			}
		} catch where isCancellation(error) {
			setPhase(.idle, for: key, generation: generation)
		} catch {
			Self.logger.error("Fetching the transcript failed: \(String(describing: error), privacy: .public)")
			setPhase(.failed(Self.fetchFailureMessage(for: error)), for: key, generation: generation)
		}
	}

	private func upload(_ transcript: YouTubeTranscript, key: String, api: any YouTubeTranscriptAPI, generation: UUID) {
		uploads[key]?.cancel()
		let delays = uploadRetryDelays
		uploads[key] = Task { [weak self] in
			var attempt = 0
			while Task.isCancelled == false {
				do {
					_ = try await api.uploadTranscript(itemID: key, transcript: transcript)
					break
				} catch {
					guard attempt < delays.count, Self.shouldRetryUpload(after: error) else {
						Self.logger.error("Uploading the transcript failed: \(String(describing: error), privacy: .public)")
						break
					}
					try? await Task.sleep(for: delays[attempt])
					attempt += 1
				}
			}
			guard let self, self.generation == generation else { return }
			self.uploads[key] = nil
		}
	}

	/// Only transient failures are retried. 413 (too large), 422 (not a video),
	/// 400 and 404 would fail the same way again.
	nonisolated static func shouldRetryUpload(after error: Error) -> Bool {
		if isCancellation(error) { return false }
		if let pigeonError = error as? PigeonError {
			guard let status = pigeonError.statusCode else { return false }
			return status == 429 || status >= 500
		}
		return isConnectivityFailure(error) || error is URLError
	}

	nonisolated static let loadFailureMessage = "The saved transcript didn't load."

	nonisolated static func fetchFailureMessage(for error: Error) -> String {
		switch error as? YouTubeTranscriptError {
		case .noTranscript: "YouTube has no captions for this video."
		case .timedOut: "YouTube took too long to answer."
		case .notAVideo: "This isn't a YouTube video."
		case .unavailable, nil: isConnectivityFailure(error) ? "You appear to be offline." : "YouTube didn't share the transcript."
		}
	}

	private func setPhase(_ phase: Phase, for key: String, generation: UUID? = nil) {
		if let generation, generation != self.generation { return }
		guard phases[key] != phase else { return }
		phases[key] = phase
		readyOrder.removeAll { $0 == key }
		guard case .ready = phase else { return }
		readyOrder.append(key)
		while readyOrder.count > Self.maximumReadyTranscripts {
			phases[readyOrder.removeFirst()] = nil
		}
	}

	private func finishTask(key: String, generation: UUID) {
		guard generation == self.generation else { return }
		tasks[key] = nil
	}
}
