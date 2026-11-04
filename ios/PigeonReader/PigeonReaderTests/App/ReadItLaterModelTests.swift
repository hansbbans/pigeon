import Foundation
import Testing
@testable import PigeonReader

@MainActor
struct ReadItLaterModelTests {
	// MARK: - Saving

	@Test func savingShowsTheLinkAtOnceAndExtractsItInTheBackground() async throws {
		let http = SavedRoutingHTTPClient()
		let harness = try Harness(http: http, extractor: SavedTestExtractor(document: try Self.document()))
		let url = try #require(URL(string: "https://example.com/essays/slow-software"))

		let outcome = try await harness.model.saveForLater(url, title: "Slow software")

		#expect(outcome == .saved)
		let saved = harness.model.articles(for: .saved)
		#expect(saved.map(\.id) == [SavedRoutingHTTPClient.itemID])
		#expect(harness.model.navigation.item(withID: ReaderSection.saved.rawValue)?.unreadCount == 1)
		// It never joins the feed views.
		#expect(harness.model.articles(for: .unread).isEmpty)
		#expect(harness.model.articles(for: .today).isEmpty)

		try await waitUntil { harness.model.article(withId: SavedRoutingHTTPClient.itemID)?.savedState == .done }
		let upload = try #require(await http.requests().last { $0.method == "PUT" })
		#expect(upload.path == "/api/v1/saved/\(SavedRoutingHTTPClient.itemID)/content")
		let body = try #require(upload.json)
		#expect(body["html"] as? String == "<p>Software that waits for you.</p>")
		#expect(body["text"] as? String == "Software that waits for you.")
		#expect(body["mediaKind"] as? String == "text")
		#expect(harness.model.article(withId: SavedRoutingHTTPClient.itemID)?.title == "Slow software, and why it lasts")
	}

	@Test func rapidRepeatsOfOneLinkSendOneRequest() async throws {
		let http = SavedRoutingHTTPClient(saveDelay: .milliseconds(150))
		let harness = try Harness(http: http)
		let url = try #require(URL(string: "https://example.com/a"))

		async let first = harness.model.saveForLater(url)
		async let second = harness.model.saveForLater(url)
		let outcomes = try await [first, second]

		#expect(outcomes.filter { $0 == .saved }.count == 1)
		#expect(outcomes.filter { $0 == .alreadySaving }.count == 1)
		#expect(await http.requests().filter { $0.method == "POST" && $0.path == "/api/v1/saved" }.count == 1)
	}

	@Test func offlineSavesAreQueuedAndFlushedLater() async throws {
		let http = SavedRoutingHTTPClient()
		await http.setOffline(true)
		let harness = try Harness(http: http)
		let first = try #require(URL(string: "https://example.com/first"))
		let second = try #require(URL(string: "https://example.com/second"))

		#expect(try await harness.model.saveForLater(first, title: "First") == .queued)
		harness.queue.enqueue(url: second, title: nil)
		#expect(harness.queue.all().map(\.url) == [first, second])

		// Still offline: nothing is lost and the queue stops at the first failure.
		await harness.model.flushPendingSavedLinks()
		#expect(harness.queue.all().count == 2)

		await http.setOffline(false)
		let sentBeforeReconnecting = await http.requests().count
		await harness.model.flushPendingSavedLinks()
		#expect(harness.queue.all().isEmpty)
		let posted = await http.requests().dropFirst(sentBeforeReconnecting)
			.filter { $0.method == "POST" }.compactMap { $0.json?["url"] as? String }
		#expect(posted == ["https://example.com/first", "https://example.com/second"])
		#expect(harness.model.articles(for: .saved).isEmpty == false)
	}

	@Test func refusedQueuedLinksAreDroppedButServerErrorsWait() async throws {
		let http = SavedRoutingHTTPClient()
		let harness = try Harness(http: http)
		let refused = try #require(URL(string: "https://example.com/refused"))
		let later = try #require(URL(string: "https://example.com/later"))
		harness.queue.enqueue(url: refused, title: nil)
		harness.queue.enqueue(url: later, title: nil)
		await http.setSaveStatus(400, for: refused.absoluteString)
		await http.setSaveStatus(503, for: later.absoluteString)

		await harness.model.flushPendingSavedLinks()

		#expect(harness.queue.all().map(\.url) == [later])
	}

	@Test func aRefusedInAppSaveReportsAnError() async throws {
		let http = SavedRoutingHTTPClient()
		let harness = try Harness(http: http)
		let url = try #require(URL(string: "https://example.com/bad"))
		await http.setSaveStatus(400, for: url.absoluteString)

		await #expect(throws: SaveForLaterError.self) {
			try await harness.model.saveForLater(url)
		}
		#expect(harness.queue.all().isEmpty)
	}

	@Test func reSavingAFailedLinkMakesItPendingWithFreshAttempts() async throws {
		let http = SavedRoutingHTTPClient()
		let extractor = SavedTestExtractor(error: ReaderViewError.extractionFailed)
		let harness = try Harness(http: http, extractor: extractor)
		let failed = SavedItemsTests.saved(SavedRoutingHTTPClient.itemID, url: "https://example.com/failed", html: "", state: .failed)
		harness.model.setArticles([failed], for: .saved)
		let scope = harness.accountID
		let attempts = SavedExtractionAttemptStore(defaults: harness.preferences)
		attempts.recordFailure(for: SavedExtractionCoordinator.attemptKey(scope: scope, itemID: failed.id))
		attempts.recordFailure(for: SavedExtractionCoordinator.attemptKey(scope: scope, itemID: failed.id))

		#expect(try await harness.model.saveForLater(try #require(failed.originalURL)) == .saved)

		#expect(attempts.attempts(for: SavedExtractionCoordinator.attemptKey(scope: scope, itemID: failed.id)) <= 1,
			"The server's pending state resets the attempts (one may already be spent by the new run)")
		try await waitUntil { harness.model.isExtractingSavedItem(failed.id) == false && extractor.extractedURLs.count == 1 }
		#expect(harness.model.article(withId: failed.id)?.savedState == .pending)
	}

	@Test func openingAQueuedItemMovesItFirstWithoutResettingAttempts() async throws {
		let http = SavedRoutingHTTPClient()
		let extractor = SavedTestExtractor(error: ReaderViewError.extractionFailed)
		extractor.delay = .milliseconds(40)
		let harness = try Harness(http: http, extractor: extractor)
		let items = (1...4).map { number in
			SavedItemsTests.saved(
				"5a7ed000-0000-4000-8000-00000000010\(number)",
				url: "https://example.com/\(number)",
				html: "",
				state: .pending,
			)
		}
		harness.model.setArticles(items, for: .saved)
		// The sweep follows the list order; the last row waits behind three.
		let last = try #require(harness.model.articles(for: .saved).last)
		let attempts = SavedExtractionAttemptStore(defaults: harness.preferences)
		let lastKey = SavedExtractionCoordinator.attemptKey(scope: harness.accountID, itemID: last.id)
		attempts.recordFailure(for: lastKey)

		harness.model.sweepPendingSavedItems()
		harness.model.prioritizeSavedExtraction(for: last)

		try await waitUntil { extractor.extractedURLs.count >= 3 }
		#expect(extractor.extractedURLs[2] == last.originalURL, "Queued behind the two running items only")
		try await waitUntil { harness.model.isExtractingSavedItem(last.id) == false }
		#expect(attempts.attempts(for: lastKey) == 2)
	}

	// MARK: - Pending sweep

	@Test func sweepExtractsEveryPendingItemAndSkipsFinishedOnes() async throws {
		let http = SavedRoutingHTTPClient()
		let extractor = SavedTestExtractor(document: try Self.document())
		let harness = try Harness(http: http, extractor: extractor)
		let pendingA = SavedItemsTests.saved("5a7ed000-0000-4000-8000-00000000000a", url: "https://example.com/a", html: "", state: .pending)
		let pendingB = SavedItemsTests.saved("5a7ed000-0000-4000-8000-00000000000b", url: "https://example.com/b", html: "", state: .pending)
		let done = SavedItemsTests.saved("5a7ed000-0000-4000-8000-00000000000c", url: "https://example.com/c")
		harness.model.setArticles([pendingA, pendingB, done], for: .saved)

		harness.model.sweepPendingSavedItems()
		harness.model.sweepPendingSavedItems()

		try await waitUntil { harness.model.articles(for: .saved).allSatisfy { $0.savedState == .done } }
		let uploads = await http.requests().filter { $0.method == "PUT" }.map(\.path)
		#expect(Set(uploads) == [
			"/api/v1/saved/\(pendingA.id)/content",
			"/api/v1/saved/\(pendingB.id)/content",
		])
		#expect(uploads.count == 2, "A second sweep must not extract an item that is already queued")
		#expect(extractor.extractedURLs.count == 2)
	}

	@Test func threeFailedAttemptsReportTheItemAsFailed() async throws {
		let http = SavedRoutingHTTPClient()
		let extractor = SavedTestExtractor(error: ReaderViewError.extractionFailed)
		let harness = try Harness(http: http, extractor: extractor)
		let pending = SavedItemsTests.saved("5a7ed000-0000-4000-8000-00000000000d", url: "https://example.com/d", html: "", state: .pending)
		harness.model.setArticles([pending], for: .saved)

		for attempt in 1...2 {
			harness.model.sweepPendingSavedItems()
			try await waitUntil { extractor.extractedURLs.count == attempt && harness.model.isExtractingSavedItem(pending.id) == false }
			#expect(harness.model.article(withId: pending.id)?.savedState == .pending)
		}
		#expect(await http.requests().contains { $0.method == "PUT" } == false)

		harness.model.sweepPendingSavedItems()
		try await waitUntil { harness.model.article(withId: pending.id)?.savedState == .failed }
		let report = try #require(await http.requests().last { $0.method == "PUT" })
		#expect(report.path == "/api/v1/saved/\(pending.id)/content")
		#expect(report.json?["failed"] as? Bool == true)
		#expect(report.json?.count == 1)

		// A failed item is not swept again; Try Again gives it fresh attempts.
		harness.model.sweepPendingSavedItems()
		#expect(harness.model.isExtractingSavedItem(pending.id) == false)
		#expect(extractor.extractedURLs.count == 3)
		extractor.error = nil
		extractor.document = try Self.document()
		harness.model.retrySavedExtraction(try #require(harness.model.article(withId: pending.id)))
		#expect(harness.model.article(withId: pending.id)?.savedState == .pending)
		try await waitUntil { harness.model.article(withId: pending.id)?.savedState == .done }
	}

	@Test func offlineFailuresDoNotSpendAttempts() async throws {
		let http = SavedRoutingHTTPClient()
		let extractor = SavedTestExtractor(error: URLError(.notConnectedToInternet))
		let harness = try Harness(http: http, extractor: extractor)
		let pending = SavedItemsTests.saved("5a7ed000-0000-4000-8000-00000000000e", url: "https://example.com/e", html: "", state: .pending)
		harness.model.setArticles([pending], for: .saved)

		for attempt in 1...4 {
			harness.model.sweepPendingSavedItems()
			try await waitUntil { extractor.extractedURLs.count == attempt && harness.model.isExtractingSavedItem(pending.id) == false }
		}
		#expect(await http.requests().contains { $0.method == "PUT" } == false)
		#expect(harness.model.article(withId: pending.id)?.savedState == .pending)
	}

	@Test func videoSavesSkipTextExtraction() async throws {
		let http = SavedRoutingHTTPClient()
		let extractor = SavedTestExtractor(document: try Self.document())
		let harness = try Harness(http: http, extractor: extractor)
		let video = SavedItemsTests.saved(
			"5a7ed000-0000-4000-8000-00000000000f",
			url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
			html: "", state: .pending, mediaKind: "video",
		)
		harness.model.setArticles([video], for: .saved)

		harness.model.sweepPendingSavedItems()

		try await waitUntil { await http.requests().contains { $0.method == "PUT" } }
		#expect(extractor.extractedURLs.isEmpty)
		let upload = try #require(await http.requests().last { $0.method == "PUT" })
		#expect(upload.json?["mediaKind"] as? String == "video")
		#expect(upload.json?["html"] == nil)
		#expect(upload.json?["title"] as? String == "Big Buck Bunny")
		#expect(upload.json?["site"] as? String == "Blender")
	}

	// MARK: - Exclusion and actions

	@Test func markAllReadInUnreadNeverArchivesSavedItems() async throws {
		let harness = try Harness(http: SavedRoutingHTTPClient())
		let story = Recommendation(
			id: "story-1", readerId: "tag:google.com,2005:reader/item/0000000000000001", feedKey: "design", source: "Design",
			title: "Story", html: "<p>Body</p>", text: nil, originalURL: nil, receivedAt: .now, isRead: false, isStarred: false,
			score: 0, confidence: 0, sampleCount: 0, explanation: "", learningState: "",
		)
		let saved = SavedItemsTests.saved("5a7ed000-0000-4000-8000-000000000010")
		harness.model.setArticles([story], for: .unread)
		harness.model.setArticles([saved], for: .saved)

		await harness.model.markAllStoriesAsRead(in: .smart(.unread))

		let pending = try await harness.store.pendingMutations(accountID: harness.accountID, limit: 100)
		let marked = pending.flatMap(\.mutation.itemIds)
		#expect(marked == [story.readerId])
		#expect(harness.model.article(withId: saved.id)?.isRead == false)
	}

	@Test func archivingMovesTheItemToArchiveAndCountsDown() async throws {
		let harness = try Harness(http: SavedRoutingHTTPClient())
		let saved = SavedItemsTests.saved("5a7ed000-0000-4000-8000-000000000011")
		harness.model.setArticles([saved], for: .saved)
		harness.model.setNavigation(ReaderNavigationState(items: ReaderSection.allCases.map { ReaderNavigationItem.smart($0, unreadCount: $0 == .saved ? 1 : 0) }))

		await harness.model.setArchived(saved, archived: true)

		#expect(harness.model.articles(for: .saved).isEmpty, "Unread is the default Read It Later filter")
		#expect(harness.model.navigation.item(withID: ReaderSection.saved.rawValue)?.unreadCount == 0)
		#expect(harness.model.navigation.item(withID: ReaderSection.unread.rawValue)?.unreadCount == 0)
		harness.model.setArticleFilter(.read, for: .saved)
		#expect(harness.model.articles(for: .saved).map(\.id) == [saved.id])
	}

	@Test func reachingTheEndArchivesOnlyAfterScrolling() async throws {
		let harness = try Harness(http: SavedRoutingHTTPClient())
		let saved = SavedItemsTests.saved("5a7ed000-0000-4000-8000-000000000013")
		harness.model.setArticles([saved], for: .saved)

		await harness.model.recordScrollDepth(itemId: saved.id, depth: 1, canScroll: false)?.value
		#expect(harness.model.article(withId: saved.id)?.isRead == false)
		await harness.model.recordExplicitOpen(for: saved)
		#expect(harness.model.article(withId: saved.id)?.isRead == false, "Opening never archives")

		await harness.model.recordScrollDepth(itemId: saved.id, depth: 0.99, canScroll: true)?.value
		#expect(harness.model.article(withId: saved.id)?.isRead == true)
	}

	@Test func removingQueuesRemoveSavedWithTheItemID() async throws {
		let harness = try Harness(http: SavedRoutingHTTPClient())
		let saved = SavedItemsTests.saved("5a7ed000-0000-4000-8000-000000000012")
		let readerOnly = SavedItemsTests.saved("tag:google.com,2005:reader/item/0000000000000099")
		harness.model.setArticles([saved, readerOnly], for: .saved)

		#expect(await harness.model.removeSaved(saved))
		#expect(await harness.model.removeSaved(readerOnly) == false)

		#expect(harness.model.articles(for: .saved).map(\.id) == [readerOnly.id])
		let pending = try await harness.store.pendingMutations(accountID: harness.accountID, limit: 100)
		#expect(pending.map(\.mutation.kind) == [.removeSaved])
		#expect(pending.first?.mutation.itemIds == [saved.id])
	}

	@Test func aQueuedRemovalStaysHiddenAndCountsDropForStarredItems() async throws {
		let harness = try Harness(http: SavedRoutingHTTPClient())
		var saved = SavedItemsTests.saved("5a7ed000-0000-4000-8000-000000000014")
		saved.isStarred = true
		harness.model.setArticles([saved], for: .saved)
		harness.model.setArticles([saved], for: .starred)
		harness.model.setNavigation(ReaderNavigationState(items: ReaderSection.allCases.map {
			ReaderNavigationItem.smart($0, unreadCount: $0 == .saved || $0 == .starred ? 1 : 0)
		}))

		#expect(await harness.model.removeSaved(saved))
		#expect(harness.model.navigation.item(withID: ReaderSection.starred.rawValue)?.unreadCount == 0)
		#expect(harness.model.navigation.item(withID: ReaderSection.saved.rawValue)?.unreadCount == 0)

		// A page or snapshot that still has it (the server has not applied the
		// removal yet) must not bring it back.
		harness.model.setArticles([saved], for: .saved)
		harness.model.setArticles([saved], for: .starred)
		#expect(harness.model.allArticles(for: .saved).isEmpty)
		#expect(harness.model.allArticles(for: .starred).isEmpty)
	}

	@Test func filtersAndSortApplyToTheDisplayedList() throws {
		let harness = try Harness(http: SavedRoutingHTTPClient())
		let now = Date.now
		let short = SavedItemsTests.saved("short", words: 400, receivedAt: now.addingTimeInterval(-10))
		let long = SavedItemsTests.saved("long", words: 4_000, receivedAt: now.addingTimeInterval(-20))
		let video = SavedItemsTests.saved("video", url: "https://youtu.be/aqz-KE-bpKQ", receivedAt: now, mediaKind: "video", duration: 300)
		harness.model.setArticles([short, long, video], for: .saved)

		#expect(harness.model.articles(for: .saved).map(\.id) == ["video", "short", "long"])
		harness.model.setSortOrder(.longest, for: .saved)
		#expect(harness.model.articles(for: .saved).map(\.id) == ["long", "video", "short"])
		harness.model.savedListFilter.kind = .text
		#expect(harness.model.articles(for: .saved).map(\.id) == ["long", "short"])
		harness.model.savedListFilter.length = .long
		#expect(harness.model.articles(for: .saved).map(\.id) == ["long"])
		#expect(SavedListFilter.load(from: harness.preferences) == SavedListFilter(kind: .text, length: .long))
		// Length sorts belong to Read It Later only.
		harness.model.setSortOrder(.shortest, for: .unread)
		#expect(harness.model.sortOrder(for: .unread) != .shortest)
	}

	@Test func streamAndCountRequestsAskTheServerToLeaveOutReadItLater() async throws {
		let ids = #"{"itemRefs":[{"id":"5"}]}"#
		let contents = """
		{"id":"x","items":[
		{"id":"tag:google.com,2005:reader/item/0000000000000005","title":"Saved","published":1793523600,"categories":[],"extractionState":"done","siteName":"Example","origin":{"streamId":"feed/4","title":"Read It Later"}}
		]}
		"""
		let http = SavedRoutingHTTPClient(streamIDs: Data(ids.utf8), streamContents: Data(contents.utf8))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "t"), httpClient: http)

		let savedFeed = try await client.recommendationsPage(from: "feed/4")
		_ = try? await client.readerUnreadCounts()
		_ = try? await client.streamContents(streamID: "user/-/state/com.google/reading-list")

		let requests = await http.requests()
		for path in ["/reader/api/0/stream/items/ids", "/reader/api/0/unread-count", "/reader/api/0/stream/contents"] {
			let request = try #require(requests.first { $0.path == path }, "\(path) was not requested")
			#expect(request.query.contains(URLQueryItem(name: "xs", value: "saved")), "\(path) must send xs=saved")
		}
		// The saved feed's own stream still lists its items, keyed on the system feed.
		#expect(savedFeed.items.map(\.title) == ["Saved"])
		#expect(savedFeed.items.first?.feedKey == SavedItems.feedKey)
		#expect(savedFeed.items.first?.saved?.siteName == "Example")
	}

	// MARK: - Helpers

	private static func document() throws -> ReaderViewDocument {
		try ReaderViewDocument(
			title: "Slow software, and why it lasts",
			byline: "Ada Lovelace",
			contentHTML: "<p>Software that waits for you.</p>",
			wordCount: 2650,
			siteName: "Example Essays",
			extractor: .defuddle,
			textContent: "Software that waits for you.",
		)
	}

	private func waitUntil(timeout: Duration = .seconds(5), _ condition: () async -> Bool) async throws {
		let deadline = ContinuousClock.now + timeout
		while await condition() == false {
			guard ContinuousClock.now < deadline else {
				Issue.record("Timed out waiting for the condition")
				return
			}
			try await Task.sleep(for: .milliseconds(10))
		}
	}

	@MainActor
	private struct Harness {
		let model: ReaderAppModel
		let store: OfflineLibraryStore
		let queue: PendingSavedLinkQueue
		let preferences: UserDefaults
		let accountID: String

		init(http: SavedRoutingHTTPClient, extractor: SavedTestExtractor = SavedTestExtractor(error: ReaderViewError.extractionFailed)) throws {
			let defaults = try #require(UserDefaults(suiteName: "pigeon-saved-model-\(UUID().uuidString)"))
			let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "token")
			store = OfflineLibraryStore.inMemory()
			queue = PendingSavedLinkQueue(directory: FileManager.default.temporaryDirectory
				.appending(path: "pigeon-saved-queue-\(UUID().uuidString)", directoryHint: .isDirectory))
			preferences = defaults
			accountID = session.storageIdentity
			model = ReaderAppModel(
				sessionStore: TestSessionStore(session: session),
				httpClient: http,
				readerModeStore: ReaderModeStore(defaults: defaults),
				articleFilterStore: ReaderArticleFilterStore(defaults: defaults),
				smartViewStore: ReaderSmartViewStore(defaults: defaults),
				offlineStore: store,
				offlineSynchronizationEnabled: false,
				readerTypography: ReaderTypographySettings(defaults: defaults),
				keyboardShortcuts: ReaderKeyboardShortcutSettings(defaults: defaults),
				savedPreferencesDefaults: defaults,
				pendingSavedLinks: queue,
				readerViewExtractor: extractor,
			)
		}
	}
}

@MainActor
final class SavedTestExtractor: ReaderViewExtracting {
	var document: ReaderViewDocument?
	var error: Error?
	var delay: Duration?
	private(set) var extractedURLs: [URL] = []

	init(document: ReaderViewDocument? = nil, error: Error? = nil) {
		self.document = document
		self.error = error
	}

	func extract(from url: URL) async throws -> ReaderViewDocument {
		extractedURLs.append(url)
		if let delay { try await Task.sleep(for: delay) }
		await Task.yield()
		if let error { throw error }
		guard let document else { throw ReaderViewError.extractionFailed }
		return document
	}

	func extract(html: String, title: String?, baseURL: URL?) async throws -> ReaderViewDocument {
		throw ReaderViewError.extractionFailed
	}
}

/// Answers the Read It Later endpoints like the Worker contract, plus YouTube
/// oEmbed and two Google Reader stream calls.
actor SavedRoutingHTTPClient: HTTPClient {
	static let itemID = "abde2a43-22dc-8734-9049-5cd424e03007"

	struct Request: Sendable {
		let method: String
		let path: String
		var query: [URLQueryItem] = []
		let body: Data?

		var json: [String: Any]? {
			body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
		}
	}

	private var recorded: [Request] = []
	private var isOffline = false
	private var saveStatuses: [String: Int] = [:]
	private let saveDelay: Duration?
	private let streamIDs: Data
	private let streamContents: Data

	init(saveDelay: Duration? = nil, streamIDs: Data = Data(#"{"itemRefs":[]}"#.utf8), streamContents: Data = Data(#"{"id":"x","items":[]}"#.utf8)) {
		self.saveDelay = saveDelay
		self.streamIDs = streamIDs
		self.streamContents = streamContents
	}

	func setOffline(_ offline: Bool) { isOffline = offline }
	func setSaveStatus(_ status: Int, for url: String) { saveStatuses[url] = status }
	func requests() -> [Request] { recorded }

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let url = request.url else { throw URLError(.badURL) }
		let method = request.httpMethod ?? "GET"
		recorded.append(Request(
			method: method,
			path: url.path(),
			query: URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [],
			body: request.httpBody,
		))
		if isOffline { throw URLError(.notConnectedToInternet) }
		var status = 200
		let body: Data
		switch (method, url.path()) {
		case ("POST", "/api/v1/saved"):
			if let saveDelay { try await Task.sleep(for: saveDelay) }
			let savedURL = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])?["url"] as? String ?? ""
			status = saveStatuses[savedURL] ?? 201
			body = try JSONSerialization.data(withJSONObject: [
				"id": Self.itemID, "readerId": "tag:google.com,2005:reader/item/0000000000000005",
				"url": savedURL, "state": "pending", "created": true,
			])
		case let ("PUT", path) where path.hasPrefix("/api/v1/saved/"):
			let failed = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])?["failed"] as? Bool == true
			body = try JSONSerialization.data(withJSONObject: [
				"id": Self.itemID, "readerId": "tag:google.com,2005:reader/item/0000000000000005",
				"url": "https://example.com", "state": failed ? "failed" : "done", "updated": true,
			])
		case (_, "/oembed"):
			body = Data(#"{"title":"Big Buck Bunny","author_name":"Blender","thumbnail_url":"https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg"}"#.utf8)
		case (_, "/reader/api/0/stream/items/ids"):
			body = streamIDs
		case (_, "/reader/api/0/stream/items/contents"):
			body = streamContents
		case ("POST", "/api/v1/mutations"):
			throw URLError(.notConnectedToInternet)
		default:
			status = 404
			body = Data()
		}
		guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil) else {
			throw URLError(.badServerResponse)
		}
		return (body, response)
	}
}

