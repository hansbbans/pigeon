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
		/// Laid out once here, so views never rebuild rows on a re-render.
		case ready(YouTubeTranscriptLayout)
		case failed(String)
		/// The server holds a transcript in a newer format than this build reads.
		/// Terminal: fetching and uploading a version 1 copy would replace it.
		case needsUpdate

		var isLoading: Bool { self == .checking || self == .fetching }
	}

	/// Shown transcripts kept in memory; older ones are read again from the server.
	static let maximumReadyTranscripts = 8

	private(set) var phases: [String: Phase] = [:]

	@ObservationIgnored private let fetcher: any YouTubeTranscriptFetching
	@ObservationIgnored private let uploadRetryDelays: [Duration]
	@ObservationIgnored var apiProvider: @MainActor () -> (any YouTubeTranscriptAPI)? = { nil }
	@ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
	@ObservationIgnored private(set) var uploads: [String: Upload] = [:]
	@ObservationIgnored private var readyOrder: [String] = []
	@ObservationIgnored private var generation = UUID()

	/// An upload in flight; `id` lets only the task that owns the entry clear it.
	struct Upload {
		let id: UUID
		let task: Task<Void, Never>
	}

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
		if phases[key] == .needsUpdate { return }
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
		for upload in uploads.values { upload.task.cancel() }
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
				setPhase(.ready(YouTubeTranscriptLayout(stored.transcript)), for: key, generation: generation)
			} else {
				setPhase(.idle, for: key, generation: generation)
			}
		} catch is YouTubeTranscriptFormatError {
			setPhase(.needsUpdate, for: key, generation: generation)
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
		// Another device may have stored it since this item last synced. A
		// failure here just means fetching it ourselves, except a newer format,
		// which a version 1 upload must not replace.
		if let api {
			do {
				if let stored = try await api.transcript(itemID: key) {
					setPhase(.ready(YouTubeTranscriptLayout(stored.transcript)), for: key, generation: generation)
					return
				}
			} catch is YouTubeTranscriptFormatError {
				setPhase(.needsUpdate, for: key, generation: generation)
				return
			} catch {
				// Fall through to fetching.
			}
		}
		guard self.generation == generation else { return }
		guard Task.isCancelled == false else {
			setPhase(.idle, for: key, generation: generation)
			return
		}
		do {
			let transcript = try await fetcher.fetchTranscript(videoID: videoID)
			guard self.generation == generation else { return }
			setPhase(.ready(YouTubeTranscriptLayout(transcript)), for: key, generation: generation)
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
		uploads[key]?.task.cancel()
		let delays = uploadRetryDelays
		let id = UUID()
		let task = Task { [weak self] in
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
			guard let self, self.uploads[key]?.id == id else { return }
			self.uploads[key] = nil
		}
		uploads[key] = Upload(id: id, task: task)
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
	nonisolated static let offlineMessage = "You appear to be offline."
	nonisolated static let needsUpdateMessage = "Update Pigeon to see this transcript."

	nonisolated static func fetchFailureMessage(for error: Error) -> String {
		switch error as? YouTubeTranscriptError {
		case .noTranscript: "YouTube has no captions for this video."
		case .timedOut: "YouTube took too long to answer."
		case .notAVideo: "This isn't a YouTube video."
		case .offline: offlineMessage
		case .unavailable, nil: isConnectivityFailure(error) ? offlineMessage : "YouTube didn't share the transcript."
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
			evict(key: readyOrder[0])
		}
	}

	/// Drops a shown transcript from memory; the next view of it reads the
	/// server (or fetches) again. An upload in flight carries on.
	func evict(key: String) {
		readyOrder.removeAll { $0 == key }
		phases[key] = nil
	}

	private func finishTask(key: String, generation: UUID) {
		guard generation == self.generation else { return }
		tasks[key] = nil
	}
}
