import Foundation
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

	private func makeArticle(
		id: String = "article-1",
		score: Int = 80,
		html: String = "<p>Cached body</p>",
		receivedAt: TimeInterval = 300,
		isRead: Bool = true,
		isStarred: Bool = false,
	) -> Recommendation {
		Recommendation(
			id: id,
			readerId: id == "article-1" ? "reader-1" : "reader-\(id)",
			feedKey: "daily",
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
}
