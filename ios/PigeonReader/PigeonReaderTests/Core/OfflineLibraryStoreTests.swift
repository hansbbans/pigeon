import Foundation
import SQLite3
import Testing
@testable import PigeonReader

struct OfflineLibraryStoreTests {
	@Test func accountDataAndDurableOutboxStayIsolatedAcrossReopen() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }

		let navigation = ReaderNavigationState(
			items: [.smart(.forYou, unreadCount: 1)],
			expandedFolderIDs: [],
		)
		let restoration = ReaderRestorationState(
			selectedNavigationID: ReaderSection.forYou.rawValue,
			selectedArticleIDs: [ReaderSection.forYou.rawValue: "article-1"],
			sortOrders: [ReaderSection.forYou.rawValue: ArticleSortOrder.newest.rawValue],
			articleFilters: [:],
			sidebarFilter: ReaderSidebarFilter.all.rawValue,
			expandedFolderIDs: [],
			compactColumn: .detail,
			readerModes: ["daily": ReaderMode.readerView.rawValue],
			articleScrollOffsets: ["article-1": 0.65],
		)
		let mutation = OfflineMutation(
			id: "mutation-1",
			kind: .setRead,
			itemIds: ["reader-1"],
			value: true,
			scope: .single,
		)

		var firstStore: OfflineLibraryStore? = OfflineLibraryStore(databaseURL: databaseURL)
		try await firstStore?.saveNavigation(navigation, accountID: "account-a")
		try await firstStore?.saveArticles([makeArticle()], collectionID: ReaderSection.forYou.rawValue, accountID: "account-a")
		try await firstStore?.saveRestoration(restoration, accountID: "account-a")
		try await firstStore?.enqueue(mutation, accountID: "account-a")

		let otherSnapshot = try await firstStore?.loadSnapshot(accountID: "account-b")
		#expect(otherSnapshot?.isEmpty == true)
		#expect(try await firstStore?.pendingMutations(accountID: "account-b", limit: 100).isEmpty == true)
		firstStore = nil

		let reopened = OfflineLibraryStore(databaseURL: databaseURL)
		let snapshot = try await reopened.loadSnapshot(accountID: "account-a")
		let pending = try await reopened.pendingMutations(accountID: "account-a", limit: 100)
		#expect(snapshot.navigation == navigation)
		#expect(snapshot.articlesByCollection[ReaderSection.forYou.rawValue]?.map(\.id) == ["article-1"])
		#expect(snapshot.restoration == restoration)
		#expect(pending.map(\.mutation.id) == ["mutation-1"])
	}

	@Test func syncPageCommitsCursorAndPreservesAFullCachedBodyAndRecommendationMetadata() async throws {
		let store = OfflineLibraryStore.inMemory()
		let original = makeArticle(score: 91, html: "<p>Keep me offline</p>")
		try await store.saveArticles([original], collectionID: "feed/7", accountID: "account-a")

		let page = try decodePage(
			"""
			{
			  "cursor": "v1:12",
			  "hasMore": false,
			  "changes": [
			    {
			      "sequence": 11,
			      "entityType": "article",
			      "entityId": "article-1",
			      "operation": "upsert",
			      "changedAt": "2026-08-15T12:00:00.000Z",
			      "payload": {
			        "id": "article-1",
			        "readerId": "reader-1",
			        "feedKey": "daily",
			        "source": "Daily",
			        "title": "Synced title",
			        "html": "",
			        "receivedAt": "2026-08-15T11:00:00.000Z",
			        "isRead": false,
			        "isStarred": false,
			        "isBodyPruned": true
			      }
			    },
			    {
			      "sequence": 12,
			      "entityType": "status",
			      "entityId": "article-1",
			      "operation": "upsert",
			      "changedAt": "2026-08-15T12:01:00.000Z",
			      "payload": {
			        "itemId": "article-1",
			        "isRead": true,
			        "isStarred": true,
			        "updatedAt": "2026-08-15T12:01:00.000Z",
			        "version": 2,
			        "mutationId": "mutation-1"
			      }
			    }
			  ]
			}
			"""
		)

		try await store.apply(page, accountID: "account-a")

		let snapshot = try await store.loadSnapshot(accountID: "account-a")
		let article = try #require(snapshot.articlesByCollection["feed/7"]?.first)
		#expect(snapshot.cursor == "v1:12")
		#expect(article.title == "Synced title")
		#expect(article.html == "<p>Keep me offline</p>")
		#expect(article.score == 91)
		#expect(article.isRead)
		#expect(article.isStarred)
	}

	@Test func feedSyncKeepsTheOfflineSubscriptionLibraryCurrent() async throws {
		let store = OfflineLibraryStore.inMemory()
		let upsert = try decodePage(
			"""
			{
			  "cursor": "v1:1",
			  "hasMore": false,
			  "changes": [{
			    "sequence": 1,
			    "entityType": "feed",
			    "entityId": "daily",
			    "operation": "upsert",
			    "changedAt": "2026-08-15T12:00:00.000Z",
			    "payload": {
			      "feedKey": "daily",
			      "streamId": "feed/7",
			      "title": "Daily Brief",
			      "feedURL": "https://example.com/feed.xml",
			      "siteURL": "https://example.com",
			      "iconURL": "https://example.com/icon.png",
			      "isActive": true,
			      "folders": ["Newsletters"]
			    }
			  }]
			}
			"""
		)
		try await store.apply(upsert, accountID: "account-a")

		let subscription = try #require(
			try await store.loadSnapshot(accountID: "account-a").subscriptions.first
		)
		#expect(subscription.id == "feed/7")
		#expect(subscription.title == "Daily Brief")
		#expect(subscription.folderNames == ["Newsletters"])
		#expect(subscription.sourceUrl?.absoluteString == "https://example.com/feed.xml")
		#expect(subscription.htmlUrl?.absoluteString == "https://example.com")
		#expect(subscription.iconUrl == "https://example.com/icon.png")

		let deletion = try decodePage(
			"""
			{
			  "cursor": "v1:2",
			  "hasMore": false,
			  "changes": [{
			    "sequence": 2,
			    "entityType": "feed",
			    "entityId": "daily",
			    "operation": "delete",
			    "changedAt": "2026-08-15T12:01:00.000Z",
			    "payload": null
			  }]
			}
			"""
		)
		try await store.apply(deletion, accountID: "account-a")

		#expect(try await store.loadSnapshot(accountID: "account-a").subscriptions.isEmpty)
	}

	@Test func prunedServerPlaceholderIsStoredAsMissingBodyForRecovery() async throws {
		let store = OfflineLibraryStore.inMemory()
		let page = try decodePage(
			"""
			{
			  "cursor": "v1:3",
			  "hasMore": false,
			  "changes": [{
			    "sequence": 3,
			    "entityType": "article",
			    "entityId": "pruned-article",
			    "operation": "upsert",
			    "changedAt": "2026-08-15T12:00:00.000Z",
			    "payload": {
			      "id": "pruned-article",
			      "readerId": "reader-pruned",
			      "feedKey": "daily",
			      "source": "Daily",
			      "title": "Pruned",
			      "html": "<p>Download this body again</p>",
			      "receivedAt": "2026-08-15T11:00:00.000Z",
			      "isRead": false,
			      "isStarred": false,
			      "isBodyPruned": true
			    }
			  }]
			}
			"""
		)

		try await store.apply(page, accountID: "account-a")

		let article = try #require(
			try await store.loadSnapshot(accountID: "account-a")
				.articlesByCollection[ReaderSection.unread.rawValue]?.first
		)
		#expect(article.html.isEmpty)
	}

	@Test func persistedPrunedPlaceholderIsMissingAfterReopenAndAnUnrelatedSyncChange() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-pruned-placeholder-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let placeholder = makeArticle(
			id: "pruned-placeholder",
			html: "<p>This older read article is no longer stored offline.</p>",
			receivedAt: 100,
		)

		do {
			let store = OfflineLibraryStore(databaseURL: databaseURL)
			try await store.saveArticles([placeholder], collectionID: "feed/7", accountID: "account-a")
		}
		try markBodyPruned(
			in: databaseURL,
			accountID: "account-a",
			articleID: placeholder.id,
		)

		let store = OfflineLibraryStore(databaseURL: databaseURL)
		let unrelatedChange = try decodePage(
			"""
			{
			  "cursor": "v1:4",
			  "hasMore": false,
			  "changes": [{
			    "sequence": 4,
			    "entityType": "feed",
			    "entityId": "other",
			    "operation": "upsert",
			    "changedAt": "2026-08-15T12:00:00.000Z",
			    "payload": {
			      "feedKey": "other",
			      "streamId": "feed/8",
			      "title": "Other",
			      "isActive": true,
			      "folders": []
			    }
			  }]
			}
			"""
		)
		try await store.apply(unrelatedChange, accountID: "account-a")

		let article = try #require(
			try await store.loadSnapshot(accountID: "account-a")
				.articlesByCollection["feed/7"]?.first
		)
		#expect(article.id == placeholder.id)
		#expect(article.html.isEmpty)
	}

	@Test func cleanupPrunesOnlyOlderReadUnstarredBodies() async throws {
		let store = OfflineLibraryStore.inMemory()
		let newestRead = makeArticle(id: "newest-read", receivedAt: 400)
		let oldRead = makeArticle(id: "old-read", receivedAt: 100)
		let unread = makeArticle(id: "unread", receivedAt: 200, isRead: false)
		let starred = makeArticle(id: "starred", receivedAt: 150, isStarred: true)
		try await store.saveArticles(
			[newestRead, unread, starred, oldRead],
			collectionID: "feed/7",
			accountID: "account-a",
		)

		let count = try await store.cleanupReadBodies(accountID: "account-a", keepingNewest: 1)
		let articles = try await store.loadSnapshot(accountID: "account-a").articlesByCollection["feed/7"] ?? []
		let bodies = Dictionary(uniqueKeysWithValues: articles.map { ($0.id, $0.html) })

		#expect(count == 1)
		#expect(bodies["old-read"] == "")
		#expect(bodies["newest-read"]?.isEmpty == false)
		#expect(bodies["unread"]?.isEmpty == false)
		#expect(bodies["starred"]?.isEmpty == false)
	}

	@Test func cachedBodiesAreSanitizedBeforeTheyReachSQLite() async throws {
		let store = OfflineLibraryStore.inMemory()
		let unsafe = makeArticle(html: #"<p>Safe</p><script>steal()</script><img src="javascript:bad">"#)

		try await store.saveArticles([unsafe], collectionID: "feed/7", accountID: "account-a")

		let cached = try #require(
			try await store.loadSnapshot(accountID: "account-a").articlesByCollection["feed/7"]?.first
		)
		#expect(cached.html == "<p>Safe</p>")
	}

	@Test func snapshotDecodesEachCachedArticlePayloadOnlyOnceAcrossCollections() async throws {
		let store = OfflineLibraryStore.inMemory()
		let articles = (0..<3).map { index in
			makeArticle(id: "shared-\(index)", feedKey: "feed-\(index)", receivedAt: TimeInterval(300 - index))
		}
		try await store.saveArticles(articles, collectionID: "folder/one", accountID: "account-a")
		try await store.saveArticles(Array(articles.reversed()), collectionID: "folder/two", accountID: "account-a")
		try await store.saveArticles([articles[1], articles[2], articles[0]], collectionID: "folder/three", accountID: "account-a")

		await store.resetSnapshotArticleDecodeCount()
		let snapshot = try await store.loadSnapshot(accountID: "account-a")

		#expect(await store.snapshotArticleDecodeCountForTesting() == articles.count)
		#expect(snapshot.articlesByCollection["folder/one"]?.map(\.id) == ["shared-0", "shared-1", "shared-2"])
		#expect(snapshot.articlesByCollection["folder/two"]?.map(\.id) == ["shared-2", "shared-1", "shared-0"])
		#expect(snapshot.articlesByCollection["folder/three"]?.map(\.id) == ["shared-1", "shared-2", "shared-0"])
	}

	@Test func lostMutationResponseCanReplayAsAlreadyAppliedExactlyOnce() async throws {
		let store = OfflineLibraryStore.inMemory()
		let mutation = OfflineMutation(
			id: "mutation-lost-response",
			kind: .setStarred,
			itemIds: ["reader-1"],
			value: true,
			scope: .single,
		)
		try await store.enqueue(mutation, accountID: "account-a")
		let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "token")
		let offlineClient = PigeonAPIClient(
			session: session,
			httpClient: MockHTTPClient(shouldFail: true),
		)
		let replayer = OfflineMutationReplayer(store: store)

		await #expect(throws: (any Error).self) {
			_ = try await replayer.replay(accountID: "account-a", apiClient: offlineClient)
		}
		let failedAttempt = try #require(try await store.pendingMutations(accountID: "account-a", limit: 100).first)
		#expect(failedAttempt.attempts == 1)
		#expect(failedAttempt.lastError?.isEmpty == false)

		let recoveredClient = PigeonAPIClient(
			session: session,
			httpClient: MockHTTPClient(responseData: Data(
				#"{"results":[{"mutationId":"mutation-lost-response","status":"already_applied","appliedAt":"2026-08-15T12:00:00.000Z","error":null}]}"#.utf8
			)),
		)
		let applied = try await replayer.replay(accountID: "account-a", apiClient: recoveredClient)

		#expect(applied == 1)
		#expect(try await store.pendingMutations(accountID: "account-a", limit: 100).isEmpty)
	}

	@Test func permanentlyInvalidMutationDropsSoLaterMutationsCanSync() async throws {
		let store = OfflineLibraryStore.inMemory()
		let rejected = OfflineMutation(
			id: "mutation-rejected",
			kind: .setRead,
			itemIds: (0..<201).map { "reader-rejected-\($0)" },
			value: true,
			scope: .all,
		)
		let later = OfflineMutation(
			id: "mutation-later",
			kind: .setStarred,
			itemIds: ["reader-later"],
			value: true,
			scope: .single,
		)
		try await store.enqueue(rejected, accountID: "account-a")
		try await store.enqueue(later, accountID: "account-a")
		let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "token")
		let client = PigeonAPIClient(
			session: session,
			httpClient: MutationResultHTTPClient(
				resultsByID: [
					later.id: "applied",
				]
			),
		)
		let replayer = OfflineMutationReplayer(store: store)

		let applied = try await replayer.replay(accountID: "account-a", apiClient: client)

		#expect(applied == 1)
		#expect(try await store.pendingMutations(accountID: "account-a", limit: 100).isEmpty)
		#expect(try await store.storageStats(accountID: "account-a").pendingMutationCount == 0)
	}

	@Test func retryableServerFailureStaysQueuedWhileLaterActionsCanSync() async throws {
		let store = OfflineLibraryStore.inMemory()
		let retryable = OfflineMutation(
			id: "mutation-retryable",
			kind: .setRead,
			itemIds: ["reader-retryable"],
			value: true,
			scope: .single,
		)
		let later = OfflineMutation(
			id: "mutation-later",
			kind: .setStarred,
			itemIds: ["reader-later"],
			value: true,
			scope: .single,
		)
		try await store.enqueue(retryable, accountID: "account-a")
		try await store.enqueue(later, accountID: "account-a")
		let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "token")
		let client = PigeonAPIClient(
			session: session,
			httpClient: MutationResultHTTPClient(
				resultsByID: [
					retryable.id: "failed",
					later.id: "applied",
				]
			),
		)
		let replayer = OfflineMutationReplayer(store: store)

		let applied = try await replayer.replay(accountID: "account-a", apiClient: client)

		#expect(applied == 1)
		let pending = try await store.pendingMutations(accountID: "account-a", limit: 100)
		#expect(pending.map(\.mutation.id) == [retryable.id])
		#expect(pending.first?.attempts == 1)
	}

	@Test func omittedMutationReceiptStaysQueuedWithoutHotLoopingLaterActions() async throws {
		let store = OfflineLibraryStore.inMemory()
		let omitted = OfflineMutation(
			id: "mutation-omitted",
			kind: .setRead,
			itemIds: (0..<201).map { "reader-omitted-\($0)" },
			value: true,
			scope: .all,
		)
		let later = OfflineMutation(
			id: "mutation-later",
			kind: .setStarred,
			itemIds: ["reader-later"],
			value: true,
			scope: .single,
		)
		try await store.enqueue(omitted, accountID: "account-a")
		try await store.enqueue(later, accountID: "account-a")
		let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "token")
		let client = PigeonAPIClient(
			session: session,
			httpClient: MutationResultHTTPClient(resultsByID: [later.id: "applied"]),
		)
		let replayer = OfflineMutationReplayer(store: store)

		let applied = try await replayer.replay(accountID: "account-a", apiClient: client)

		#expect(applied == 0)
		#expect(try await store.pendingMutations(accountID: "account-a", limit: 100).map(\.mutation.id) == [
			omitted.id,
			later.id,
		])
		#expect(try await store.pendingMutations(accountID: "account-a", limit: 100).first?.attempts == 1)
	}

	@Test func clearingCachedArticlesNeverDeletesPendingActions() async throws {
		let store = OfflineLibraryStore.inMemory()
		try await store.saveArticles([makeArticle()], collectionID: "feed/7", accountID: "account-a")
		try await store.enqueue(
			OfflineMutation(id: "pending-1", kind: .setRead, itemIds: ["reader-1"], value: true, scope: .single),
			accountID: "account-a",
		)

		try await store.clearCachedArticles(accountID: "account-a")

		#expect(try await store.loadSnapshot(accountID: "account-a").articlesByCollection.isEmpty)
		#expect(try await store.pendingMutations(accountID: "account-a", limit: 100).map(\.mutation.id) == ["pending-1"])
	}

	@Test func localSearchCoversMetadataAndSanitizedBodiesWithCollectionAndAccountScope() async throws {
		let store = OfflineLibraryStore.inMemory()
		let metadataMatch = Recommendation(
			id: "metadata", readerId: "reader-metadata", feedKey: "swift", source: "Swift Weekly",
			author: "Alice Appleseed", title: "Structured concurrency", html: "<p>Actors</p>",
			text: "Safe isolation", originalURL: nil, receivedAt: Date(timeIntervalSince1970: 200),
			isRead: false, isStarred: false, score: 10, confidence: 0, sampleCount: 0,
			explanation: "Fresh", learningState: "Starting",
		)
		let bodyMatch = Recommendation(
			id: "body", readerId: "reader-body", feedKey: "nature", source: "Nature",
			title: "Field notes", html: "<p>Rare platypus habitat</p>", text: nil,
			originalURL: nil, receivedAt: Date(timeIntervalSince1970: 100), isRead: false,
			isStarred: false, score: 5, confidence: 0, sampleCount: 0,
			explanation: "Fresh", learningState: "Starting",
		)
		try await store.saveArticles([metadataMatch], collectionID: "feed/swift", accountID: "account-a")
		try await store.saveArticles([bodyMatch], collectionID: "feed/nature", accountID: "account-a")
		try await store.saveArticles([bodyMatch], collectionID: "feed/nature", accountID: "account-b")

		let author = try await store.searchArticles(query: "alice swift", collectionID: "feed/swift", accountID: "account-a", limit: 20)
		let wrongCollection = try await store.searchArticles(query: "platypus", collectionID: "feed/swift", accountID: "account-a", limit: 20)
		let fullLibrary = try await store.searchArticles(query: "platypus habitat", collectionID: nil, accountID: "account-a", limit: 20)
		let wrongAccount = try await store.searchArticles(query: "concurrency", collectionID: nil, accountID: "account-b", limit: 20)

		#expect(author.map(\.id) == [metadataMatch.id])
		#expect(wrongCollection.isEmpty)
		#expect(fullLibrary.map(\.id) == [bodyMatch.id])
		#expect(wrongAccount.isEmpty)
	}

	private func makeArticle(
		id: String = "article-1",
		feedKey: String = "daily",
		score: Int = 80,
		html: String = "<p>Cached body</p>",
		receivedAt: TimeInterval = 300,
		isRead: Bool = true,
		isStarred: Bool = false,
	) -> Recommendation {
		Recommendation(
			id: id,
			readerId: id == "article-1" ? "reader-1" : "reader-\(id)",
			feedKey: feedKey,
			source: "Daily",
			title: "Story \(id)",
			html: html,
			text: "Cached body",
			originalURL: URL(string: "https://example.com/\(id)"),
			receivedAt: Date(timeIntervalSince1970: receivedAt),
			isRead: isRead,
			isStarred: isStarred,
			score: score,
			confidence: 0.8,
			sampleCount: 8,
			explanation: "A learned recommendation",
			learningState: "Personalized",
		)
	}

	private func decodePage(_ json: String) throws -> IncrementalSyncPage {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .custom { decoder in
			let value = try decoder.singleValueContainer().decode(String.self)
			let formatter = ISO8601DateFormatter()
			formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
			guard let date = formatter.date(from: value) else {
				throw DecodingError.dataCorruptedError(
					in: try decoder.singleValueContainer(),
					debugDescription: "Expected an ISO 8601 date",
				)
			}
			return date
		}
		return try decoder.decode(IncrementalSyncPage.self, from: Data(json.utf8))
	}

	private func markBodyPruned(in databaseURL: URL, accountID: String, articleID: String) throws {
		var database: OpaquePointer?
		guard sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK,
			let database else {
			throw TestSQLiteError.openFailed
		}
		defer { sqlite3_close(database) }

		var statement: OpaquePointer?
		guard sqlite3_prepare_v2(
			database,
			"UPDATE cached_articles SET body_pruned = 1 WHERE account_id = ? AND id = ?",
			-1,
			&statement,
			nil,
		) == SQLITE_OK,
			let statement else {
			throw TestSQLiteError.prepareFailed
		}
		defer { sqlite3_finalize(statement) }
		guard accountID.withCString({ sqlite3_bind_text(statement, 1, $0, -1, testSQLiteTransient) }) == SQLITE_OK,
			articleID.withCString({ sqlite3_bind_text(statement, 2, $0, -1, testSQLiteTransient) }) == SQLITE_OK,
			sqlite3_step(statement) == SQLITE_DONE else {
			throw TestSQLiteError.updateFailed
		}
	}
}

nonisolated(unsafe) private let testSQLiteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private enum TestSQLiteError: Error {
	case openFailed
	case prepareFailed
	case updateFailed
}

actor MutationResultHTTPClient: HTTPClient {
	private let resultsByID: [String: String]

	init(resultsByID: [String: String]) {
		self.resultsByID = resultsByID
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		guard let requestBody = request.httpBody else {
			throw PigeonError.invalidResponse
		}
		let envelope = try JSONDecoder().decode(OfflineMutationEnvelope.self, from: requestBody)
		let results = envelope.mutations.compactMap { mutation -> String? in
			guard let status = resultsByID[mutation.id] else { return nil }
			return """
			{"mutationId":"\(mutation.id)","status":"\(status)","appliedAt":"2026-08-15T12:00:00.000Z","error":null}
			"""
		}
		let body = Data("{\"results\":[\(results.joined(separator: ","))]}".utf8)
		let url = request.url ?? Self.fallbackURL
		guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
			throw PigeonError.invalidResponse
		}
		return (body, response)
	}

	private static var fallbackURL: URL {
		guard let url = URL(string: "https://pigeon.test") else {
			preconditionFailure("The test URL must be valid")
		}
		return url
	}
}
