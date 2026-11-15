import Foundation
import SwiftUI
import Testing
@testable import PigeonReader

/// The reading log: batched impressions, and the exact reading time sent when
/// reading stops. Both are analytics, so every failure must stay silent.
@MainActor
struct ReadingLogTests {
	private static let readingLogPath = "/api/v1/reading-log"
	private static let engagementPath = "/api/v1/engagement"
	private let start = Date(timeIntervalSince1970: 1_794_733_200)

	// MARK: - Impression batching

	@Test func manyImpressionsGoOutInOneRequest() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		model.setArticles([makeArticle(id: "story-0", score: 82)], for: .forYou)

		model.recordImpressions(impressions(120), in: .list(for: .smart(.forYou)))
		await model.waitForReadingAnalytics()

		let batches = try await readingLogBatches(transport)
		#expect(batches.map(\.count) == [120])
		let first = try #require(batches.first?.first)
		#expect(first["itemId"] as? String == "story-0")
		#expect(first["type"] as? String == "impression")
		#expect(first["view"] as? String == "for-you")
		#expect(first["position"] as? Int == 0)
		#expect(first["sessionId"] as? String == "session-1")
		#expect(first["occurredAt"] as? String == "2026-11-15T09:00:00Z")
		#expect(first["metadata"] as? [String: Int] == ["score": 82])
		// Rows without a For You score send no metadata at all.
		#expect(batches[0][1]["metadata"] == nil)
		let ids = batches[0].compactMap { $0["id"] as? String }
		#expect(Set(ids).count == 120)
		#expect(ids.allSatisfy { $0 == $0.lowercased() && UUID(uuidString: $0) != nil })
		#expect(await transport.requestCount(path: Self.engagementPath) == 0)
		#expect(model.errorMessage == nil)
	}

	@Test func impressionsWaitForTheThresholdThenFlushTogether() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		let rows = impressions(ReaderAppModel.readingLogFlushThreshold)

		for impression in rows.dropLast() {
			model.recordImpressions([impression], in: .list(for: .smart(.unread)), flushInterval: .seconds(3_600))
		}
		for _ in 0..<20 { await Task.yield() }
		#expect(await transport.requestCount(path: Self.readingLogPath) == 0)

		model.recordImpressions([rows[rows.count - 1]], in: .list(for: .smart(.unread)), flushInterval: .seconds(3_600))
		await model.waitForReadingAnalytics()

		let batches = try await readingLogBatches(transport)
		#expect(batches.map(\.count) == [ReaderAppModel.readingLogFlushThreshold])
		#expect(batches[0].allSatisfy { $0["view"] as? String == "unread" && $0["metadata"] == nil })
	}

	@Test func aQuietListFlushesOnItsTimer() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)

		model.recordImpressions(Array(impressions(3).prefix(2)), in: .list(for: .smart(.today)), flushInterval: .milliseconds(20))
		model.recordImpressions(Array(impressions(3).suffix(1)), in: .list(for: .smart(.today)), flushInterval: .milliseconds(20))
		await model.waitForReadingAnalytics()

		#expect(try await readingLogBatches(transport).map(\.count) == [3])
	}

	@Test func endingAListSessionFlushesWhatIsWaiting() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)

		model.recordImpressions(impressions(3), in: .list(for: .smart(.starred)), flushInterval: .seconds(3_600))
		model.flushReadingLog()
		model.flushReadingLog()
		await model.waitForReadingAnalytics()

		#expect(try await readingLogBatches(transport).map(\.count) == [3])
	}

	@Test func aBatchNeverExceedsTheServerLimit() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)

		model.recordImpressions(impressions(450), in: .list(for: .smart(.unread)))
		await model.waitForReadingAnalytics()

		#expect(try await readingLogBatches(transport).map(\.count) == [200, 200, 50])
	}

	@Test func feedFolderAndSearchListsAreLabelled() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		let feed = navigationItem(id: "feed/7", kind: .feed)
		let folder = navigationItem(id: "user/-/label/Work", kind: .folder)
		let one = impressions(1)

		model.recordImpressions(one, in: .list(for: feed))
		model.recordImpressions(one, in: .list(for: folder))
		model.recordImpressions(one, in: .list(for: feed, search: .collection))
		model.recordImpressions(one, in: .list(for: feed, search: .library))
		model.recordImpressions(one, in: .list(for: .smart(.forYou), search: .collection))
		model.recordImpressions(one, in: .list(for: .smart(.saved)))
		model.flushReadingLog()
		await model.waitForReadingAnalytics()

		let events = try #require(try await readingLogBatches(transport).first)
		#expect(events.map { $0["view"] as? String } == ["feed", "folder", "search", "search", "search", "saved"])
		#expect(events.map { $0["metadata"] as? [String: String] } == [
			["stream": "feed/7"], ["stream": "user/-/label/Work"], ["stream": "feed/7"], nil, nil, nil,
		])
	}

	// MARK: - Silent failures and accounts

	@Test(arguments: [404, 400, 500])
	func aRejectedReadingLogIsDroppedWithoutABanner(status: Int) async throws {
		let transport = ReadingLogTransport(statuses: [Self.readingLogPath: status])
		let model = try makeModel(transport)

		model.recordImpressions(impressions(60), in: .list(for: .smart(.forYou)))
		await model.waitForReadingAnalytics()
		model.flushReadingLog()
		await model.waitForReadingAnalytics()

		#expect(model.errorMessage == nil)
		// One attempt, no retry, nothing kept for later.
		#expect(await transport.requestCount(path: Self.readingLogPath) == 1)
	}

	@Test func aNetworkFailureIsDroppedWithoutABanner() async throws {
		let model = try makeModel(MockHTTPClient(shouldFail: true))

		model.recordImpressions(impressions(60), in: .list(for: .smart(.forYou)))
		await model.waitForReadingAnalytics()

		#expect(model.errorMessage == nil)
	}

	@Test func impressionsBufferedForOneAccountAreNotSentToTheNext() async throws {
		let transport = ReadingLogTransport(loginToken: "next-account")
		let model = try makeModel(transport)

		model.recordImpressions(impressions(3), in: .list(for: .smart(.forYou)), flushInterval: .seconds(3_600))
		model.disconnect()
		model.password = "password"
		await model.connect()
		model.flushReadingLog()
		await model.waitForReadingAnalytics()

		#expect(await transport.requestCount(path: Self.readingLogPath) == 0)
	}

	@Test(.timeLimit(.minutes(1))) func aReadingLogInFlightKeepsItsAccountAndStaysSilent() async throws {
		let transport = ReadingLogTransport(
			statuses: [Self.readingLogPath: 500],
			loginToken: "next-account",
			gatedPath: Self.readingLogPath,
		)
		let model = try makeModel(transport)

		model.recordImpressions(impressions(60), in: .list(for: .smart(.forYou)))
		await transport.waitUntilGated()
		model.disconnect()
		model.password = "password"
		await model.connect()
		model.errorMessage = "Current reader message"
		await transport.releaseGate()
		await model.waitForReadingAnalytics()

		#expect(model.errorMessage == "Current reader message")
		let sent = await transport.requests(path: Self.readingLogPath)
		#expect(sent.count == 1)
		#expect(sent.first?.value(forHTTPHeaderField: "Authorization") == "GoogleLogin auth=pigeon/server-token")
	}

	@Test(.timeLimit(.minutes(1))) func backgroundingSendsWaitingImpressionsUnderTheBackgroundTask() async throws {
		let transport = ReadingLogTransport(gatedPath: Self.readingLogPath)
		let runner = RecordingSceneBackgroundTaskRunner()
		let model = try makeModel(transport, sceneBackgroundTasks: runner)

		model.recordImpressions(impressions(3), in: .list(for: .smart(.forYou)), flushInterval: .seconds(3_600))
		model.handleScenePhase(.background)
		await transport.waitUntilGated()

		#expect(runner.beginCount == 1)
		#expect(runner.endCount == 0)
		await transport.releaseGate()
		await model.waitForSceneBackgroundFlush()
		#expect(runner.endCount == 1)
		#expect(try await readingLogBatches(transport).map(\.count) == [3])
	}

	@Test(.timeLimit(.minutes(1))) func aHungAnalyticsRequestDoesNotHoldTheBackgroundFlushOpen() async throws {
		let transport = ReadingLogTransport(gatedPath: Self.readingLogPath)
		let runner = RecordingSceneBackgroundTaskRunner()
		let model = try makeModel(transport, sceneBackgroundTasks: runner)
		model.analyticsBackgroundWaitLimit = .milliseconds(50)

		model.recordImpressions(impressions(3), in: .list(for: .smart(.forYou)), flushInterval: .seconds(3_600))
		model.handleScenePhase(.background)
		await transport.waitUntilGated()
		// The request never answers; the flush gives up on it and finishes.
		await model.waitForSceneBackgroundFlush()
		#expect(runner.endCount == 1)

		// So the next backgrounding runs its own flush.
		model.handleScenePhase(.active)
		model.handleScenePhase(.background)
		await model.waitForSceneBackgroundFlush()
		#expect(runner.beginCount == 2)
		#expect(runner.endCount == 2)
		await transport.releaseGate()
		await model.waitForReadingAnalytics()
	}

	// MARK: - Exact reading time

	@Test(.timeLimit(.minutes(1))) func closingAfterFourSecondsReportsThoseFourSeconds() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		model.readerTypography.markReadBehavior = .manually
		let clock = ScriptedClock([start, start.addingTimeInterval(4)])

		// The 15 s poll never fires: the reader closes first, cancelling the task.
		let reading = Task { await model.monitorActiveReading(for: "story", now: { clock.next() }) }
		await clock.waitUntilRead()
		await model.recordScrollDepth(itemId: "story", depth: 0.5)?.value
		reading.cancel()
		await reading.value
		await model.waitForReadingAnalytics()

		let events = try await activeReadingEvents(transport)
		#expect(events.count == 1)
		#expect(events.first?["itemId"] as? String == "story")
		#expect(events.first?["durationSeconds"] as? Double == 4)
		#expect(events.first?["scrollDepth"] as? Double == 0.5)
		#expect(model.errorMessage == nil)
	}

	@Test func aLongReadReportsThePolledChunkAndThenTheRemainder() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		let clock = ScriptedClock([start, start.addingTimeInterval(15), start.addingTimeInterval(25)])

		await model.monitorActiveReading(for: "story", interval: .zero, maximumIntervals: 1, now: { clock.next() })
		await model.waitForReadingAnalytics()

		let durations = try await activeReadingEvents(transport).map { $0["durationSeconds"] as? Double }
		#expect(durations == [15, 10])
	}

	@Test(.timeLimit(.minutes(1))) func closingWhileAPolledChunkIsInFlightStillDeliversIt() async throws {
		let transport = ReadingLogTransport(gatedPath: Self.engagementPath)
		let model = try makeModel(transport)
		let clock = ScriptedClock([start, start.addingTimeInterval(15), start.addingTimeInterval(18)])

		let reading = Task { await model.monitorActiveReading(for: "story", interval: .zero, now: { clock.next() }) }
		// The 15 s chunk is on the wire when the reader closes.
		await transport.waitUntilGated()
		reading.cancel()
		await transport.releaseGate()
		await reading.value
		await model.waitForReadingAnalytics()

		let durations = try await transport.deliveredRequests(path: Self.engagementPath)
			.flatMap { try events(in: $0) }
			.filter { $0["type"] as? String == "active_reading" }
			.map { $0["durationSeconds"] as? Double }
		#expect(durations == [15, 3])
	}

	@Test func aReadUnderOneSecondSendsNothing() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		let clock = ScriptedClock([start, start.addingTimeInterval(0.5)])

		await model.monitorActiveReading(for: "story", maximumIntervals: 0, now: { clock.next() })
		await model.waitForReadingAnalytics()

		#expect(await transport.requestCount(path: Self.engagementPath) == 0)
	}

	@Test(.timeLimit(.minutes(1))) func backgroundingThenReturningKeepsCountingFromZero() async throws {
		let transport = ReadingLogTransport(gatedPath: Self.engagementPath)
		let runner = RecordingSceneBackgroundTaskRunner()
		let model = try makeModel(transport, sceneBackgroundTasks: runner)
		// The monitor's own stop comes after the scene already reported.
		let firstClock = ScriptedClock([start, start.addingTimeInterval(8)])

		let firstRead = Task { await model.monitorActiveReading(for: "story", now: { firstClock.next() }) }
		await firstClock.waitUntilRead()
		model.handleScenePhase(.inactive, now: start.addingTimeInterval(6))
		model.handleScenePhase(.background, now: start.addingTimeInterval(7))
		// The request was started by the scene change and holds the background task open.
		await transport.waitUntilGated()
		#expect(runner.beginCount == 1)
		#expect(runner.endCount == 0)
		firstRead.cancel()
		await firstRead.value
		await transport.releaseGate()
		await model.waitForSceneBackgroundFlush()
		#expect(runner.endCount == 1)

		// An hour in the background is not reading time.
		model.handleScenePhase(.active, now: start.addingTimeInterval(3_600))
		let secondClock = ScriptedClock([start.addingTimeInterval(3_600), start.addingTimeInterval(3_605)])
		await model.monitorActiveReading(for: "story", maximumIntervals: 0, now: { secondClock.next() })
		await model.waitForReadingAnalytics()

		let durations = try await activeReadingEvents(transport).map { $0["durationSeconds"] as? Double }
		#expect(durations == [6, 5])
	}

	@Test func aMonitorThatUnwindsLateDoesNotStopItsReplacement() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		let firstClock = ScriptedClock([start, start.addingTimeInterval(100)])

		let firstRead = Task { await model.monitorActiveReading(for: "story", now: { firstClock.next() }) }
		await firstClock.waitUntilRead()
		model.handleScenePhase(.inactive, now: start.addingTimeInterval(2))
		model.handleScenePhase(.active, now: start.addingTimeInterval(10))
		// The replacement starts before the cancelled monitor has unwound.
		let secondClock = ScriptedClock([start.addingTimeInterval(10), start.addingTimeInterval(13)])
		let secondRead = Task { await model.monitorActiveReading(for: "story", now: { secondClock.next() }) }
		await secondClock.waitUntilRead()
		firstRead.cancel()
		await firstRead.value
		secondRead.cancel()
		await secondRead.value
		await model.waitForReadingAnalytics()

		let durations = try await activeReadingEvents(transport).map { $0["durationSeconds"] as? Double }
		#expect(durations == [2, 3])
	}

	@Test func theFinalReadingTimeFailsSilently() async throws {
		let transport = ReadingLogTransport(statuses: [Self.engagementPath: 500])
		let model = try makeModel(transport)
		let clock = ScriptedClock([start, start.addingTimeInterval(4)])

		await model.monitorActiveReading(for: "story", maximumIntervals: 0, now: { clock.next() })
		await model.waitForReadingAnalytics()

		#expect(await transport.requestCount(path: Self.engagementPath) == 1)
		#expect(model.errorMessage == nil)
	}

	@Test(.timeLimit(.minutes(1))) func readingTimeFromThePreviousAccountIsNotReportedToTheNext() async throws {
		let transport = ReadingLogTransport(loginToken: "next-account")
		let model = try makeModel(transport)
		let clock = ScriptedClock([start, start.addingTimeInterval(30)])

		let reading = Task { await model.monitorActiveReading(for: "story", now: { clock.next() }) }
		await clock.waitUntilRead()
		model.disconnect()
		model.password = "password"
		await model.connect()
		reading.cancel()
		await reading.value
		await model.waitForReadingAnalytics()

		#expect(await transport.requestCount(path: Self.engagementPath) == 0)
	}

	// MARK: - List sessions (recorder)

	@Test func aListSessionLogsEachVisibleRowOnceAndANewSessionLogsAgain() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		let clock = ManualClock(start)
		let recorder = ReaderImpressionRecorder(now: { clock.now })
		let list = ReadingLogList.list(for: .smart(.unread))

		recorder.updateRows(["a", "b", "c"])
		recorder.apply(.init(sessionKey: "unread|all", list: list, isPaused: false), model: model)
		let firstSession = try #require(recorder.sessionId)
		recorder.setRowVisible("b", true)
		recorder.setRowVisible("a", true)
		clock.advance(0.5)
		recorder.evaluate()
		clock.advance(1)
		recorder.evaluate()
		// Still visible a while later: nothing new for this session.
		clock.advance(5)
		recorder.evaluate()

		// The filter changed; the same rows are still on screen.
		recorder.apply(.init(sessionKey: "unread|unread", list: list, isPaused: false), model: model)
		let secondSession = try #require(recorder.sessionId)
		clock.advance(1)
		recorder.evaluate()
		recorder.endSession()
		await model.waitForReadingAnalytics()

		#expect(firstSession != secondSession)
		#expect(recorder.sessionId == nil)
		let batches = try await readingLogBatches(transport)
		// One request per session end, never one per row.
		#expect(batches.count == 2)
		#expect(batches.first?.map { $0["itemId"] as? String } == ["a", "b"])
		#expect(batches.first?.map { $0["position"] as? Int } == [0, 1])
		#expect(batches.first?.allSatisfy { $0["sessionId"] as? String == firstSession } == true)
		#expect(batches.last?.map { $0["itemId"] as? String } == ["a", "b"])
		#expect(batches.last?.allSatisfy { $0["sessionId"] as? String == secondSession } == true)
	}

	@Test func aRowTappedInItsFirstSecondIsLoggedAsShown() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		let clock = ManualClock(start)
		let recorder = ReaderImpressionRecorder(now: { clock.now })
		let list = ReadingLogList.list(for: .smart(.unread))

		recorder.updateRows(["a", "b", "c"])
		recorder.apply(.init(sessionKey: "unread", list: list, isPaused: false), model: model)
		recorder.setRowVisible("c", true)
		clock.advance(0.25)
		// Tapped before its second was up; then the reader covers the list.
		recorder.rowChosen("c")
		recorder.rowChosen("c")
		recorder.rowChosen("not-in-this-list")
		recorder.apply(.init(sessionKey: "unread", list: list, isPaused: true), model: model)
		clock.advance(120)
		recorder.apply(.init(sessionKey: "unread", list: list, isPaused: false), model: model)
		clock.advance(2)
		recorder.evaluate()
		recorder.endSession()
		await model.waitForReadingAnalytics()

		let events = try await readingLogBatches(transport).flatMap { $0 }
		#expect(events.map { $0["itemId"] as? String } == ["c"])
		#expect(events.first?["position"] as? Int == 2)
	}

	@Test func timeUnderTheReaderOrInTheBackgroundDoesNotCount() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		let clock = ManualClock(start)
		let recorder = ReaderImpressionRecorder(now: { clock.now })
		let list = ReadingLogList.list(for: .smart(.unread))
		let showing = ReaderImpressionRecorder.ListState(sessionKey: "unread", list: list, isPaused: false)
		let covered = ReaderImpressionRecorder.ListState(sessionKey: "unread", list: list, isPaused: true)

		recorder.updateRows(["a", "b"])
		recorder.setRowVisible("a", true)
		recorder.apply(showing, model: model)
		let session = recorder.sessionId
		clock.advance(0.5)
		recorder.apply(covered, model: model)
		// While covered, "a" was read and left the list; "b" moved up under the reader.
		clock.advance(600)
		recorder.updateRows(["b"])
		recorder.setRowVisible("b", true)
		recorder.evaluate()
		recorder.apply(showing, model: model)
		clock.advance(0.75)
		recorder.evaluate()
		clock.advance(0.25)
		recorder.evaluate()
		recorder.endSession()
		await model.waitForReadingAnalytics()

		#expect(recorder.sessionId == nil)
		let events = try #require(try await readingLogBatches(transport).first)
		#expect(events.map { $0["itemId"] as? String } == ["b"])
		#expect(events.first?["position"] as? Int == 0)
		#expect(events.first?["sessionId"] as? String == session)
	}

	@Test func rowChangesAreLookedAtAtMostEveryQuarterSecond() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		let clock = ManualClock(start)
		let recorder = ReaderImpressionRecorder(now: { clock.now })
		let list = ReadingLogList.list(for: .smart(.unread))

		recorder.updateRows(["a", "b"])
		recorder.apply(.init(sessionKey: "unread", list: list, isPaused: false), model: model)
		clock.advance(0.125)
		// Inside the throttle window: noted, but not evaluated yet.
		recorder.setRowVisible("a", true)
		clock.advance(0.125)
		recorder.setRowVisible("b", true)
		// One second after "a" was reported, but only 0.875 s after the list was looked at.
		clock.advance(0.875)
		recorder.evaluate()
		model.flushReadingLog()
		#expect(await transport.requestCount(path: Self.readingLogPath) == 0)
		clock.advance(0.125)
		recorder.evaluate()
		model.flushReadingLog()
		await model.waitForReadingAnalytics()

		#expect(try await readingLogBatches(transport).first?.map { $0["itemId"] as? String } == ["a", "b"])
	}

	@Test func anOffScreenListHasNoSession() async throws {
		let transport = ReadingLogTransport()
		let model = try makeModel(transport)
		let clock = ManualClock(start)
		let recorder = ReaderImpressionRecorder(now: { clock.now })
		let list = ReadingLogList.list(for: .smart(.unread))

		recorder.updateRows(["a"])
		recorder.setRowVisible("a", true)
		recorder.apply(.init(sessionKey: nil, list: list, isPaused: false), model: model)
		clock.advance(5)
		recorder.evaluate()
		#expect(recorder.sessionId == nil)

		// It comes on screen with the row already visible.
		recorder.apply(.init(sessionKey: "unread", list: list, isPaused: false), model: model)
		clock.advance(1)
		recorder.evaluate()
		recorder.apply(.init(sessionKey: nil, list: list, isPaused: false), model: model)
		await model.waitForReadingAnalytics()

		#expect(recorder.sessionId == nil)
		#expect(try await readingLogBatches(transport).map(\.count) == [1])
	}

	@Test func returningAfterALongAbsenceStartsANewListSession() throws {
		let model = try makeModel(ReadingLogTransport())
		let epoch = model.readingLogSessionEpoch

		model.handleScenePhase(.background, now: start)
		model.handleScenePhase(.active, now: start.addingTimeInterval(60))
		#expect(model.readingLogSessionEpoch == epoch)

		model.handleScenePhase(.background, now: start.addingTimeInterval(120))
		model.handleScenePhase(.active, now: start.addingTimeInterval(120 + ReaderAppModel.keptArticlesForegroundResetInterval))
		#expect(model.readingLogSessionEpoch == epoch + 1)
	}

	// MARK: - Helpers

	/// The events of each reading-log request, in the order they were sent.
	private func readingLogBatches(_ transport: ReadingLogTransport) async throws -> [[[String: Any]]] {
		try await transport.requests(path: Self.readingLogPath).map(events)
	}

	private func activeReadingEvents(_ transport: ReadingLogTransport) async throws -> [[String: Any]] {
		try await transport.requests(path: Self.engagementPath)
			.flatMap(events)
			.filter { $0["type"] as? String == "active_reading" }
	}

	private func events(in request: URLRequest) throws -> [[String: Any]] {
		let body = try #require(request.httpBody)
		let payload = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
		return try #require(payload["events"] as? [[String: Any]])
	}

	private func impressions(_ count: Int) -> [ImpressionTracker.Impression] {
		(0..<count).map {
			ImpressionTracker.Impression(itemId: "story-\($0)", position: $0, sessionId: "session-1", occurredAt: start)
		}
	}

	private func navigationItem(id: String, kind: ReaderNavigationKind) -> ReaderNavigationItem {
		ReaderNavigationItem(
			id: id, title: "Alpha", streamID: id, kind: kind, unreadCount: 0,
			parentID: nil, feedKey: nil, iconURL: nil, smartSection: nil,
		)
	}

	private func makeArticle(id: String, score: Int) -> Recommendation {
		Recommendation(
			id: id,
			readerId: "tag:google.com,2005:reader/item/\(id)",
			feedKey: "daily",
			source: "Daily",
			title: "Story \(id)",
			html: "<p>Body</p>",
			text: "Body",
			originalURL: nil,
			receivedAt: start,
			isRead: false,
			isStarred: false,
			score: score,
			confidence: 0,
			sampleCount: 0,
			explanation: "Starting with recency",
			learningState: "Starting with recency",
		)
	}

	private func makeModel(
		_ httpClient: any HTTPClient,
		sceneBackgroundTasks: (any SceneBackgroundTaskRunning)? = nil,
	) throws -> ReaderAppModel {
		let defaults = try #require(UserDefaults(suiteName: "pigeon-reading-log-\(UUID().uuidString)"))
		let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "server-token")
		return ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: httpClient,
			readerModeStore: ReaderModeStore(defaults: defaults),
			articleFilterStore: ReaderArticleFilterStore(defaults: defaults),
			smartViewStore: ReaderSmartViewStore(defaults: defaults),
			offlineStore: OfflineLibraryStore.inMemory(),
			offlineSynchronizationEnabled: false,
			readerTypography: ReaderTypographySettings(defaults: defaults),
			keyboardShortcuts: ReaderKeyboardShortcutSettings(defaults: defaults),
			savedPreferencesDefaults: defaults,
			sceneBackgroundTasks: sceneBackgroundTasks ?? RecordingSceneBackgroundTaskRunner(),
			saveWidgetSnapshot: { _ in },
		)
	}
}

/// Returns the scripted dates in order, repeating the last one.
@MainActor
private final class ScriptedClock {
	private var dates: [Date]
	private var reads = 0

	init(_ dates: [Date]) {
		self.dates = dates
	}

	func next() -> Date {
		reads += 1
		return dates.count > 1 ? dates.removeFirst() : dates[0]
	}

	/// The monitor reads its start time once it owns the reading clock.
	func waitUntilRead() async {
		while reads == 0 { await Task.yield() }
	}
}

@MainActor
private final class ManualClock {
	private(set) var now: Date

	init(_ start: Date) {
		now = start
	}

	func advance(_ seconds: TimeInterval) {
		now.addTimeInterval(seconds)
	}
}

/// Answers the reading-log, engagement and sign-in endpoints, records every
/// request, and can hold the first request to one path until released.
private actor ReadingLogTransport: HTTPClient {
	private let statuses: [String: Int]
	private let loginToken: String
	private let gatedPath: String?
	private var recorded: [URLRequest] = []
	private var delivered: [URLRequest] = []
	private var gate: CheckedContinuation<Void, Never>?
	private var didGate = false
	private var gateWaiters: [CheckedContinuation<Void, Never>] = []

	init(statuses: [String: Int] = [:], loginToken: String = "server-token", gatedPath: String? = nil) {
		self.statuses = statuses
		self.loginToken = loginToken
		self.gatedPath = gatedPath
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		recorded.append(request)
		let url = try #require(request.url)
		if url.path == gatedPath, didGate == false {
			didGate = true
			await withCheckedContinuation { continuation in
				gate = continuation
				for waiter in gateWaiters { waiter.resume() }
				gateWaiters.removeAll()
			}
		}
		// URLSession fails a request whose task was cancelled while it was in flight.
		try Task.checkCancellation()
		delivered.append(request)
		var status = statuses[url.path] ?? 200
		let body: Data
		switch url.path {
		case "/accounts/ClientLogin": body = Data("Auth=pigeon/\(loginToken)".utf8)
		case "/api/v1/reading-log": body = Data(#"{"accepted":0,"skipped":0,"clientFamily":"ios"}"#.utf8)
		case "/api/v1/engagement": body = Data(#"{"accepted":1}"#.utf8)
		case "/reader/api/0/subscription/list": body = Data(#"{"subscriptions":[]}"#.utf8)
		default:
			body = Data("Unexpected request".utf8)
			status = 503
		}
		let response = try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
		return (body, response)
	}

	func waitUntilGated() async {
		if didGate { return }
		await withCheckedContinuation { gateWaiters.append($0) }
	}

	func releaseGate() {
		gate?.resume()
		gate = nil
	}

	func requests(path: String) -> [URLRequest] {
		recorded.filter { $0.url?.path == path }
	}

	func requestCount(path: String) -> Int {
		requests(path: path).count
	}

	/// Requests that reached the server: not cancelled while in flight.
	func deliveredRequests(path: String) -> [URLRequest] {
		delivered.filter { $0.url?.path == path }
	}

}
