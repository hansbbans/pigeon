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
		PendingSavedLinkQueue.enqueue(url: second, title: nil, defaults: harness.sharedDefaults)
		#expect(PendingSavedLinkQueue.all(defaults: harness.sharedDefaults).map(\.url) == [first, second])

		// Still offline: nothing is lost and the queue stops at the first failure.
		await harness.model.flushPendingSavedLinks()
		#expect(PendingSavedLinkQueue.all(defaults: harness.sharedDefaults).count == 2)

		await http.setOffline(false)
		let sentBeforeReconnecting = await http.requests().count
		await harness.model.flushPendingSavedLinks()
		#expect(PendingSavedLinkQueue.all(defaults: harness.sharedDefaults).isEmpty)
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
		PendingSavedLinkQueue.enqueue(url: refused, title: nil, defaults: harness.sharedDefaults)
		PendingSavedLinkQueue.enqueue(url: later, title: nil, defaults: harness.sharedDefaults)
		await http.setSaveStatus(400, for: refused.absoluteString)
		await http.setSaveStatus(503, for: later.absoluteString)

		await harness.model.flushPendingSavedLinks()

		#expect(PendingSavedLinkQueue.all(defaults: harness.sharedDefaults).map(\.url) == [later])
	}

	@Test func aRefusedInAppSaveReportsAnError() async throws {
		let http = SavedRoutingHTTPClient()
		let harness = try Harness(http: http)
		let url = try #require(URL(string: "https://example.com/bad"))
		await http.setSaveStatus(400, for: url.absoluteString)

		await #expect(throws: SaveForLaterError.self) {
			try await harness.model.saveForLater(url)
		}
		#expect(PendingSavedLinkQueue.all(defaults: harness.sharedDefaults).isEmpty)
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

	@Test func readingListStreamsDropSavedItemsButTheirOwnFeedKeepsThem() async throws {
		let ids = #"{"itemRefs":[{"id":"1"},{"id":"5"}]}"#
		let contents = """
		{"id":"x","items":[
		{"id":"tag:google.com,2005:reader/item/0000000000000001","title":"Story","published":1793523600,"categories":[],"origin":{"streamId":"feed/1","title":"Design"}},
		{"id":"tag:google.com,2005:reader/item/0000000000000005","title":"Saved","published":1793523600,"categories":[],"extractionState":"done","siteName":"Example","origin":{"streamId":"feed/4","title":"Read It Later"}}
		]}
		"""
		let http = SavedRoutingHTTPClient(streamIDs: Data(ids.utf8), streamContents: Data(contents.utf8))
		let client = PigeonAPIClient(session: PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "t"), httpClient: http)

		let readingList = try await client.recommendationsPage(from: "user/-/state/com.google/reading-list")
		#expect(readingList.items.map(\.title) == ["Story"])
		let savedFeed = try await client.recommendationsPage(from: "feed/4")
		#expect(savedFeed.items.map(\.title) == ["Story", "Saved"])
		#expect(savedFeed.items.last?.feedKey == SavedItems.feedKey)
		#expect(savedFeed.items.last?.saved?.siteName == "Example")
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
		let sharedDefaults: UserDefaults
		let preferences: UserDefaults
		let accountID: String

		init(http: SavedRoutingHTTPClient, extractor: SavedTestExtractor = SavedTestExtractor(error: ReaderViewError.extractionFailed)) throws {
			let defaults = try #require(UserDefaults(suiteName: "pigeon-saved-model-\(UUID().uuidString)"))
			let shared = try #require(UserDefaults(suiteName: "pigeon-saved-shared-\(UUID().uuidString)"))
			let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "token")
			store = OfflineLibraryStore.inMemory()
			sharedDefaults = shared
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
				sharedDefaults: shared,
				readerViewExtractor: extractor,
			)
		}
	}
}

@MainActor
final class SavedTestExtractor: ReaderViewExtracting {
	var document: ReaderViewDocument?
	var error: Error?
	private(set) var extractedURLs: [URL] = []

	init(document: ReaderViewDocument? = nil, error: Error? = nil) {
		self.document = document
		self.error = error
	}

	func extract(from url: URL) async throws -> ReaderViewDocument {
		extractedURLs.append(url)
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
		recorded.append(Request(method: method, path: url.path(), body: request.httpBody))
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
