import Foundation
import Testing
@testable import PigeonReader

@MainActor
struct ReaderAppModelPrewarmTests {
	@Test func prewarmFetchesOnlyTwoVisibleUncachedFeedsAndPreservesContinuation() async throws {
		let (model, folder, feeds, client) = try makeFixture()
		let initialSelection = model.selectedNavigationID

		await model.prewarmFeeds(in: folder)

		let requests = await client.requests()
		let idRequests = requests.filter { $0.path == "/reader/api/0/stream/items/ids" }
		#expect(idRequests.count == 2)
		#expect(idRequests.compactMap { $0.query["s"] } == [feeds[0].streamID, feeds[1].streamID])
		#expect(idRequests.allSatisfy { $0.query["n"] == String(ReaderFeedPrewarmPolicy.firstScreenPageLimit) })
		#expect(model.hasCachedCollection(feeds[0]))
		#expect(model.hasCachedCollection(feeds[1]))
		#expect(model.hasCachedCollection(feeds[2]) == false)
		#expect(model.collectionStatusText(for: feeds[0]).hasPrefix("Live · updated"))
		#expect(model.paginationToken(for: feeds[0]) == "\(feeds[0].streamID)-next")
		#expect(model.selectedNavigationID == initialSelection)
		#expect(model.errorMessage == nil)

		await model.loadMore(collection: feeds[0])

		let afterLoadMore = await client.requests().filter { $0.path == "/reader/api/0/stream/items/ids" }
		#expect(afterLoadMore.last?.query["c"] == "\(feeds[0].streamID)-next")
		#expect(model.paginationToken(for: feeds[0]) == nil)
		#expect(model.allArticles(for: feeds[0]).count == ReaderFeedPrewarmPolicy.firstScreenPageLimit + 1)
	}

	@Test func openingAPrewarmedFeedPersistsMembershipBeforeCollectionSearch() async throws {
		let (model, folder, feeds, _) = try makeFixture()

		await model.prewarmFeeds(in: folder)
		model.select(item: feeds[0])
		await model.loadForDisplay(collection: feeds[0])

		let outcome = await model.searchArticles(query: "Story", scope: .collection, in: feeds[0])
		#expect(outcome == .completed)
		#expect(model.searchResults.count == ReaderFeedPrewarmPolicy.firstScreenPageLimit)
	}

	@Test func prewarmSkipsCachedAndForegroundInFlightFeeds() async throws {
		let (model, folder, feeds, client) = try makeFixture(blockedStreamIDs: ["feed/2"])
		model.setArticles([Self.article(id: "already-cached")], for: feeds[0])

		let foregroundLoad = Task { @MainActor in
			await model.load(collection: feeds[1], force: true)
		}
		defer { foregroundLoad.cancel() }
		let requestStarted = await waitForRequest(client, path: "/reader/api/0/stream/items/ids", streamID: feeds[1].streamID)
		try #require(requestStarted)
		try #require(await waitForGate(client, streamID: feeds[1].streamID, count: 1))
		await model.prewarmFeeds(in: folder)
		await client.releaseNext(streamID: feeds[1].streamID)
		await foregroundLoad.value

		let idRequests = await client.requests().filter { $0.path == "/reader/api/0/stream/items/ids" }
		#expect(idRequests.filter { $0.query["s"] == feeds[0].streamID }.isEmpty)
		#expect(idRequests.filter { $0.query["s"] == feeds[1].streamID }.count == 1)
		#expect(idRequests.filter { $0.query["s"] == feeds[2].streamID }.count == 1)
		#expect(model.hasCachedCollection(feeds[0]))
		#expect(model.hasCachedCollection(feeds[1]))
		#expect(model.hasCachedCollection(feeds[2]))
	}

	@Test func cancelledPrewarmDoesNotInstallAnEmptyOrPartialCollection() async throws {
		let (model, folder, feeds, client) = try makeFixture(blockedStreamIDs: ["feed/1"])
		let task = Task { @MainActor in
			await model.prewarmFeeds(in: folder)
		}
		defer { task.cancel() }
		let requestStarted = await waitForRequest(client, path: "/reader/api/0/stream/items/ids", streamID: feeds[0].streamID)
		try #require(requestStarted)
		try #require(await waitForGate(client, streamID: feeds[0].streamID, count: 1))
		task.cancel()
		await task.value

		#expect(model.hasCachedCollection(feeds[0]) == false)
		#expect(model.paginationToken(for: feeds[0]) == nil)
		#expect(model.errorMessage == nil)
	}

	@Test func selectionChangeInvalidatesACompletedButStalePrewarmPage() async throws {
		let (model, folder, feeds, client) = try makeFixture(blockedStreamIDs: ["feed/1"])
		let task = Task { @MainActor in
			await model.prewarmFeeds(in: folder)
		}
		defer { task.cancel() }
		let requestStarted = await waitForRequest(client, path: "/reader/api/0/stream/items/ids", streamID: feeds[0].streamID)
		try #require(requestStarted)
		try #require(await waitForGate(client, streamID: feeds[0].streamID, count: 1))
		model.select(item: feeds[1])
		await client.releaseNext(streamID: feeds[0].streamID)
		await task.value

		#expect(model.selectedNavigationID == feeds[1].id)
		#expect(model.hasCachedCollection(feeds[0]) == false)
		#expect(model.errorMessage == nil)
	}

	@Test func readMutationInvalidatesPrewarmBeforeItsResponseCanReplaceState() async throws {
		let (model, folder, feeds, client) = try makeFixture(blockedStreamIDs: ["feed/1"])
		let article = Self.article(id: "existing")
		model.setArticles([article], for: .forYou)

		let task = Task { @MainActor in
			await model.prewarmFeeds(in: folder)
		}
		defer { task.cancel() }
		let requestStarted = await waitForRequest(client, path: "/reader/api/0/stream/items/ids", streamID: feeds[0].streamID)
		try #require(requestStarted)
		try #require(await waitForGate(client, streamID: feeds[0].streamID, count: 1))
		await model.setRead(article, read: true)
		await client.releaseNext(streamID: feeds[0].streamID)
		await task.value

		#expect(model.allArticles(for: .forYou).first?.isRead == true)
		#expect(model.hasCachedCollection(feeds[0]) == false)
	}

	@Test func stalePrewarmCleanupCannotClearNewerFeedRequest() async throws {
		let (model, folder, feeds, client) = try makeFixture(blockedStreamIDs: ["feed/1"])
		let staleTask = Task { @MainActor in
			await model.prewarmFeeds(in: folder)
		}
		defer { staleTask.cancel() }
		try #require(await waitForRequest(client, path: "/reader/api/0/stream/items/ids", streamID: feeds[0].streamID))
		try #require(await waitForGate(client, streamID: feeds[0].streamID, count: 1))

		model.select(item: feeds[1])
		let newerTask = Task { @MainActor in
			await model.prewarmFeeds(in: folder)
		}
		defer { newerTask.cancel() }
		try #require(await waitForRequestCount(client, path: "/reader/api/0/stream/items/ids", streamID: feeds[0].streamID, count: 2))
		try #require(await waitForGate(client, streamID: feeds[0].streamID, count: 2))

		await client.releaseNext(streamID: feeds[0].streamID)
		await staleTask.value
		#expect(model.hasCachedCollection(feeds[0]) == false)

		await client.releaseNext(streamID: feeds[0].streamID)
		await newerTask.value
		#expect(model.hasCachedCollection(feeds[0]))
	}

	private func makeFixture(
		blockedStreamIDs: Set<String> = [],
	) throws -> (
		model: ReaderAppModel,
		folder: ReaderNavigationItem,
		feeds: [ReaderNavigationItem],
		client: PrewarmHTTPClient,
	) {
		let folder = ReaderNavigationItem(
			id: "folder",
			title: "Folder",
			streamID: "user/-/label/Folder",
			kind: .folder,
			unreadCount: 3,
			parentID: nil,
			feedKey: nil,
			iconURL: nil,
			smartSection: nil,
		)
		let feeds = (1...3).map { index in
			ReaderNavigationItem(
				id: "folder::feed-\(index)",
				title: "Feed \(index)",
				streamID: "feed/\(index)",
				kind: .feed,
				unreadCount: 1,
				parentID: folder.id,
				feedKey: "feed-\(index)",
				iconURL: nil,
				smartSection: nil,
			)
		}
		let client = PrewarmHTTPClient(
			streams: Dictionary(uniqueKeysWithValues: feeds.map { feed in
				let firstIDs = (1...ReaderFeedPrewarmPolicy.firstScreenPageLimit).map { "\(feed.streamID)-\($0)" }
				return (
					feed.streamID,
					PrewarmHTTPClient.StreamPages(
						firstIDs: firstIDs,
						firstContinuation: "\(feed.streamID)-next",
						nextIDs: ["\(feed.streamID)-older"],
					),
				)
			}),
			blockedStreamIDs: blockedStreamIDs,
		)
		let session = PigeonSession(baseURL: URL(string: "https://pigeon.test")!, token: "prewarm-token")
		let model = ReaderAppModel(
			sessionStore: PrewarmSessionStore(session: session),
			httpClient: client,
			offlineStore: OfflineLibraryStore.inMemory(),
			offlineSynchronizationEnabled: false,
		)
		model.setNavigation(
			ReaderNavigationState(
				items: ReaderSection.allCases.map { ReaderNavigationItem.smart($0) } + [folder] + feeds,
			),
		)
		model.toggleFolder(folder)
		return (model, folder, feeds, client)
	}

	private func waitForRequest(
		_ client: PrewarmHTTPClient,
		path: String,
		streamID: String,
	) async -> Bool {
		for _ in 0..<1_000 {
			if await client.requests().contains(where: { $0.path == path && $0.query["s"] == streamID }) {
				return true
			}
			await Task.yield()
		}
		return false
	}

	private func waitForRequestCount(
		_ client: PrewarmHTTPClient,
		path: String,
		streamID: String,
		count: Int,
	) async -> Bool {
		for _ in 0..<1_000 {
			if await client.requests().count(where: { $0.path == path && $0.query["s"] == streamID }) >= count {
				return true
			}
			await Task.yield()
		}
		return false
	}

	private func waitForGate(
		_ client: PrewarmHTTPClient,
		streamID: String,
		count: Int,
	) async -> Bool {
		for _ in 0..<1_000 {
			if await client.pendingGateCount(streamID: streamID) >= count {
				return true
			}
			await Task.yield()
		}
		return false
	}

	private static func article(id: String) -> Recommendation {
		Recommendation(
			id: id,
			readerId: id,
			feedKey: "existing",
			source: "Existing",
			title: id,
			html: "<p>Body</p>",
			text: "Body",
			originalURL: nil,
			receivedAt: Date(timeIntervalSince1970: 1_786_272_000),
			isRead: false,
			isStarred: false,
			score: 0,
			confidence: 0,
			sampleCount: 0,
			explanation: "Test",
			learningState: "Test",
		)
	}
}

@MainActor
private final class PrewarmSessionStore: SessionStore {
	private let storedSession: PigeonSession

	init(session: PigeonSession) {
		storedSession = session
	}

	func load() throws -> PigeonSession? { storedSession }
	func save(_ session: PigeonSession) throws {}
	func remove() throws {}
}

private actor PrewarmHTTPClient: HTTPClient {
	struct StreamPages: Sendable {
		let firstIDs: [String]
		let firstContinuation: String?
		let nextIDs: [String]
	}

	struct Request: Sendable {
		let path: String
		let query: [String: String]
		let bodyItemIDs: [String]
	}

	private let streams: [String: StreamPages]
	private let itemStreamIDs: [String: String]
	private let blockedStreamIDs: Set<String>
	private var gateWaiters: [String: [(UUID, CheckedContinuation<Void, Error>)]] = [:]
	private var capturedRequests: [Request] = []

	init(
		streams: [String: StreamPages],
		blockedStreamIDs: Set<String> = [],
	) {
		self.streams = streams
		self.blockedStreamIDs = blockedStreamIDs
		self.itemStreamIDs = streams.reduce(into: [String: String]()) { result, pair in
			for itemID in pair.value.firstIDs + pair.value.nextIDs {
				result[itemID] = pair.key
			}
		}
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let url = request.url else { throw PigeonError.invalidServerURL }
		let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
		let query = queryItems.reduce(into: [String: String]()) { result, item in
			if let value = item.value { result[item.name] = value }
		}
		let bodyItemIDs = Self.formValues(from: request.httpBody, named: "i")
		capturedRequests.append(Request(path: url.path, query: query, bodyItemIDs: bodyItemIDs))

		if url.path == "/reader/api/0/stream/items/ids" {
			try await waitForReleaseIfNeeded(streamID: query["s"] ?? "")
		}

		let data: Data
		switch url.path {
		case "/reader/api/0/stream/items/ids":
			let streamID = query["s"] ?? ""
			let pages = streams[streamID]
			let isContinuationRequest = query["c"] != nil
			let ids = isContinuationRequest ? (pages?.nextIDs ?? []) : (pages?.firstIDs ?? [])
			let continuation = query["c"] == nil ? pages?.firstContinuation : nil
			let refs = ids.map { "{\"id\":\"\($0)\"}" }.joined(separator: ",")
			let continuationField = continuation.map { ",\"continuation\":\"\($0)\"" } ?? ""
			data = Data("{\"itemRefs\":[\(refs)]\(continuationField)}".utf8)
		case "/reader/api/0/stream/items/contents":
			let streamID = bodyItemIDs.compactMap { itemStreamIDs[$0] }.first ?? "feed/unknown"
			let items = bodyItemIDs.map { itemID in
				"{\"id\":\"\(itemID)\",\"categories\":[],\"title\":\"Story \(itemID)\",\"published\":1786272000,\"summary\":{\"content\":\"<p>Body</p>\"},\"content\":{\"content\":\"<p>Body</p>\"},\"alternate\":[],\"origin\":{\"streamId\":\"\(streamID)\",\"title\":\"\(streamID)\",\"htmlUrl\":\"https://example.com\"}}"
			}.joined(separator: ",")
			data = Data("{\"id\":\"\(streamID)\",\"items\":[\(items)]}".utf8)
		case "/api/v1/mutations":
			data = Data("{\"results\":[]}".utf8)
		default:
			data = Data("{}".utf8)
		}

		guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
			throw PigeonError.invalidResponse
		}
		return (data, response)
	}

	func requests() -> [Request] { capturedRequests }

	func pendingGateCount(streamID: String) -> Int {
		gateWaiters[streamID]?.count ?? 0
	}

	func releaseNext(streamID: String) {
		guard var waiters = gateWaiters[streamID], waiters.isEmpty == false else {
			return
		}
		let (_, waiter) = waiters.removeFirst()
		gateWaiters[streamID] = waiters.isEmpty ? nil : waiters
		waiter.resume()
	}

	private func waitForReleaseIfNeeded(streamID: String) async throws {
		guard blockedStreamIDs.contains(streamID) else {
			return
		}
		let waiterID = UUID()
		try await withTaskCancellationHandler(operation: {
			try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
				if Task.isCancelled {
					continuation.resume(throwing: CancellationError())
				} else {
					gateWaiters[streamID, default: []].append((waiterID, continuation))
				}
			}
		}, onCancel: {
			Task { await self.cancelGateWaiter(streamID: streamID, waiterID: waiterID) }
		})
	}

	private func cancelGateWaiter(streamID: String, waiterID: UUID) {
		guard var waiters = gateWaiters[streamID],
			let index = waiters.firstIndex(where: { $0.0 == waiterID }) else {
			return
		}
		let (_, waiter) = waiters.remove(at: index)
		gateWaiters[streamID] = waiters.isEmpty ? nil : waiters
		waiter.resume(throwing: CancellationError())
	}

	private static func formValues(from body: Data?, named name: String) -> [String] {
		let rawBody = String(decoding: body ?? Data(), as: UTF8.self)
		let queryItems = URLComponents(string: "https://pigeon.test/?\(rawBody)")?.queryItems ?? []
		return queryItems.filter { $0.name == name }.compactMap(\.value)
	}
}
