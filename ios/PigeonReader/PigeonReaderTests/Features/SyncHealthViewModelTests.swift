import Foundation
import Testing
@testable import PigeonReader

@MainActor
struct SyncHealthViewModelTests {
	@Test func loadPublishesAHealthSnapshot() async {
		let recorder = SyncHealthServiceRecorder()
		let service = StubSyncHealthService(snapshot: Self.snapshot, recorder: recorder)
		let model = SyncHealthViewModel(service: service)

		await model.load()

		#expect(model.state == .loaded)
		#expect(model.snapshot?.feeds.first?.title == "Example")
		#expect(await recorder.loadCount() == 1)
	}

	@Test func retryQueuesTheFeedAndReloadsHealth() async throws {
		let recorder = SyncHealthServiceRecorder()
		let service = StubSyncHealthService(snapshot: Self.snapshot, recorder: recorder)
		let model = SyncHealthViewModel(service: service)
		let feed = try #require(Self.snapshot.feeds.first)

		await model.retry(feed)

		#expect(await recorder.retriedFeedKeys() == ["example"])
		#expect(await recorder.loadCount() == 1)
		#expect(model.retryErrors.isEmpty)
		#expect(model.isRetrying(feed) == false)
	}

	@Test func aLoadFailureIsVisibleWithoutDiscardingAnExistingSnapshot() async {
		let recorder = SyncHealthServiceRecorder()
		let initialService = StubSyncHealthService(snapshot: Self.snapshot, recorder: recorder)
		let model = SyncHealthViewModel(service: initialService)
		await model.load()

		await recorder.setLoadError(TestError.offline)
		await model.load()

		#expect(model.state == .failed("Offline"))
		#expect(model.snapshot?.feeds.count == 1)
	}

	private static let snapshot = SyncHealthSnapshot(
		generatedAt: Date(timeIntervalSince1970: 1_776_262_200),
		dueCount: 1,
		backedOffCount: 0,
		leasedCount: 0,
		healthyCount: 0,
		feeds: [
			SyncHealthFeed(
				feedKey: "example",
				title: "Example",
				host: "example.com",
				state: "failing",
				lastAttemptAt: nil,
				lastSuccessAt: nil,
				nextFetchAt: nil,
				retryAt: nil,
				consecutiveFailures: 1,
				httpStatus: 503,
				outcome: "http_error",
				durationMs: 250,
				error: "HTTP 503",
				canRetry: true,
			),
		],
		recentActivity: [],
	)
}

private enum TestError: LocalizedError {
	case offline

	var errorDescription: String? { "Offline" }
}

private actor SyncHealthServiceRecorder {
	private var loads = 0
	private var retries: [String] = []
	private var error: TestError?

	func recordLoad() throws {
		loads += 1
		if let error { throw error }
	}

	func recordRetry(_ feedKey: String) {
		retries.append(feedKey)
	}

	func setLoadError(_ error: TestError) {
		self.error = error
	}

	func loadCount() -> Int { loads }
	func retriedFeedKeys() -> [String] { retries }
}

private struct StubSyncHealthService: SyncHealthServicing {
	let snapshot: SyncHealthSnapshot
	let recorder: SyncHealthServiceRecorder

	func syncHealth() async throws -> SyncHealthSnapshot {
		try await recorder.recordLoad()
		return snapshot
	}

	func retryFeed(feedKey: String) async throws {
		await recorder.recordRetry(feedKey)
	}
}
