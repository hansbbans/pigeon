import Foundation
import SQLite3
import Testing
@testable import PigeonReader

struct OfflineLibraryStoreTests {
	@Test func savingNavigationTwiceReplacesTheExistingSnapshot() async throws {
		let store = OfflineLibraryStore.inMemory()
		let accountID = "account-a"
		let first = ReaderNavigationState(
			items: [.smart(.forYou, unreadCount: 1)],
			expandedFolderIDs: [],
		)
		let second = ReaderNavigationState(
			items: [.smart(.unread, unreadCount: 2)],
			expandedFolderIDs: [],
		)

		try await store.saveNavigation(first, accountID: accountID)
		try await store.saveNavigation(second, accountID: accountID)

		let snapshot = try await store.loadSnapshot(accountID: accountID)
		#expect(snapshot.navigation == second)
		#expect(snapshot.navigation?.item(withID: ReaderSection.forYou.rawValue) == nil)
		#expect(snapshot.navigation?.item(withID: ReaderSection.unread.rawValue)?.unreadCount == 2)
	}

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

	@Test func interruptedSyncStaysIncompleteAndDoesNotRecordLastSuccess() async throws {
		let store = OfflineLibraryStore.inMemory()
		let attempt = Date(timeIntervalSince1970: 1_000)
		try await store.beginFullRebuild(accountID: "account-a", at: attempt)
		try await store.apply(
			IncrementalSyncPage(cursor: "v1:1", hasMore: true, changes: []),
			accountID: "account-a",
		)

		let stats = try await store.storageStats(accountID: "account-a")
		let snapshot = try await store.loadSnapshot(accountID: "account-a")
		#expect(stats.cacheState == .needsRepair)
		#expect(stats.navigationFreshness == .unverified)
		#expect(stats.lastSuccessAt == nil)
		#expect(stats.lastSyncAt == nil)
		// A rebuild cursor belongs to the uncommitted stage. The committed snapshot
		// remains readable and its cursor is intentionally unchanged until promotion.
		#expect(snapshot.cursor == nil)
		let staged = try await store.loadStagedSnapshot(accountID: "account-a")
		#expect(staged.cursor == "v1:1")
	}

	@Test func clearingCachedArticlesInvalidatesCursorAndIntegrity() async throws {
		let store = OfflineLibraryStore.inMemory()
		try await store.apply(
			IncrementalSyncPage(cursor: "v1:1", hasMore: false, changes: []),
			accountID: "account-a",
		)
		try await store.clearCachedArticles(accountID: "account-a")

		let snapshot = try await store.loadSnapshot(accountID: "account-a")
		let stats = try await store.storageStats(accountID: "account-a")
		#expect(snapshot.cursor == nil)
		#expect(snapshot.integrity.state == .needsBootstrap)
		#expect(snapshot.integrity.navigation == .unverified)
		#expect(stats.lastSyncAt == nil)
	}

	@Test func fullRebuildPreservesPendingActionsAndReaderState() async throws {
		let store = OfflineLibraryStore.inMemory()
		let accountID = "account-a"
		let restoration = ReaderRestorationState(
			selectedNavigationID: ReaderSection.forYou.rawValue,
			selectedArticleIDs: [ReaderSection.forYou.rawValue: "article-1"],
			sortOrders: [:],
			articleFilters: [:],
			sidebarFilter: ReaderSidebarFilter.all.rawValue,
			expandedFolderIDs: [],
			compactColumn: .content,
			readerModes: [:],
			articleScrollOffsets: ["article-1": 0.5],
		)
		try await store.saveNavigation(
			ReaderNavigationState(items: [.smart(.forYou, unreadCount: 1)], expandedFolderIDs: []),
			accountID: accountID,
		)
		try await store.saveArticles([makeArticle(id: "article-1")], collectionID: ReaderSection.forYou.rawValue, accountID: accountID)
		try await store.saveRestoration(restoration, accountID: accountID)
		try await store.enqueue(
			OfflineMutation(id: "pending-1", kind: .setRead, itemIds: ["reader-1"], value: true),
			accountID: accountID,
		)

		try await store.beginFullRebuild(accountID: accountID, at: Date(timeIntervalSince1970: 1_000))
		let snapshot = try await store.loadSnapshot(accountID: accountID)
		let pending = try await store.pendingMutations(accountID: accountID, limit: 100)
		#expect(snapshot.navigation != nil)
		#expect(snapshot.subscriptions.isEmpty)
		#expect(snapshot.articlesByCollection[ReaderSection.forYou.rawValue]?.map(\.id) == ["article-1"])
		#expect(snapshot.restoration == restoration)
		#expect(pending.map(\.mutation.id) == ["pending-1"])
		#expect(snapshot.integrity.state == .needsRepair)
		#expect(snapshot.cursor == nil)
	}

	@Test func abandoningFullRebuildRoutesSubsequentWritesToCanonicalSnapshot() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-abandon-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "account-a"
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		let initial = ReaderNavigationState(items: [.smart(.forYou, unreadCount: 1)], expandedFolderIDs: [])
		let staged = ReaderNavigationState(items: [.smart(.unread, unreadCount: 2)], expandedFolderIDs: [])
		let afterAbandon = ReaderNavigationState(items: [.smart(.starred, unreadCount: 3)], expandedFolderIDs: [])
		let startedAt = Date(timeIntervalSince1970: 1_000)

		// Keep a feed-derived fallback around so a stale unverified navigation
		// rebuild would overwrite the newer direct save below.
		try await store.apply(
			try decodePage(
				"""
				{
				  "cursor": "v1:feed",
				  "hasMore": false,
				  "changes": [{
				    "sequence": 1,
				    "entityType": "feed",
				    "entityId": "old-feed",
				    "operation": "upsert",
				    "changedAt": "2026-08-15T12:00:00.000Z",
				    "payload": {
				      "feedKey": "old-feed",
				      "streamId": "old-stream",
				      "title": "Old feed",
				      "isActive": true,
				      "folders": []
				    }
				  }]
				}
				"""
			),
			accountID: accountID,
		)
		try await store.saveNavigation(initial, accountID: accountID)
		try await store.beginFullRebuild(accountID: accountID, at: startedAt)
		try await store.saveNavigation(staged, accountID: accountID)
		#expect(try queryTestInt(
			"SELECT COUNT(*) FROM cache_rebuilds WHERE account_id = ?",
			in: databaseURL,
			bindings: [accountID],
		) == 1)
		#expect(try queryTestInt(
			"SELECT COUNT(*) FROM cached_navigation WHERE account_id GLOB '__pigeon_rebuild__*'",
			in: databaseURL,
		) == 1)

		try await store.abandonFullRebuild(accountID: accountID, startedAt: startedAt)
		try await store.saveNavigation(afterAbandon, accountID: accountID)

		let snapshot = try await store.loadSnapshot(accountID: accountID)
		#expect(snapshot.navigation == afterAbandon)
		// Abandonment only changes the process-local write route. The durable marker
		// and stage remain for the next beginFullRebuild to reclaim.
		#expect(try queryTestInt(
			"SELECT COUNT(*) FROM cache_rebuilds WHERE account_id = ?",
			in: databaseURL,
			bindings: [accountID],
		) == 1)
		#expect(try queryTestInt(
			"SELECT COUNT(*) FROM cached_navigation WHERE account_id GLOB '__pigeon_rebuild__*'",
			in: databaseURL,
		) == 1)
	}

	@Test func staleRebuildTokenCannotAbandonNewGeneration() async throws {
		let store = OfflineLibraryStore.inMemory()
		let accountID = "account-a"
		let oldNavigation = ReaderNavigationState(items: [.smart(.forYou, unreadCount: 1)], expandedFolderIDs: [])
		let stagedNavigation = ReaderNavigationState(items: [.smart(.unread, unreadCount: 2)], expandedFolderIDs: [])
		let finalNavigation = ReaderNavigationState(items: [.smart(.starred, unreadCount: 3)], expandedFolderIDs: [])
		let oldStartedAt = Date(timeIntervalSince1970: 1_000)
		let newStartedAt = Date(timeIntervalSince1970: 2_000)

		try await store.saveNavigation(oldNavigation, accountID: accountID)
		try await store.beginFullRebuild(accountID: accountID, at: oldStartedAt)
		try await store.beginFullRebuild(accountID: accountID, at: newStartedAt)
		try await store.abandonFullRebuild(accountID: accountID, startedAt: oldStartedAt)

		// The old token must not clear the new process-local generation. This write
		// therefore remains staged and invisible to the committed snapshot.
		try await store.saveNavigation(stagedNavigation, accountID: accountID)
		#expect(try await store.loadSnapshot(accountID: accountID).navigation == oldNavigation)

		try await store.abandonFullRebuild(accountID: accountID, startedAt: newStartedAt)
		try await store.saveNavigation(finalNavigation, accountID: accountID)
		#expect(try await store.loadSnapshot(accountID: accountID).navigation == finalNavigation)
	}

	@Test func interruptedFullRebuildReopenPreservesCommittedSnapshot() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-abandon-reopen-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "account-a"
		let navigation = ReaderNavigationState(items: [.smart(.forYou, unreadCount: 1)], expandedFolderIDs: [])
		var store: OfflineLibraryStore? = OfflineLibraryStore(databaseURL: databaseURL)
		try await store?.saveNavigation(navigation, accountID: accountID)
		try await store?.saveArticles([makeArticle()], collectionID: ReaderSection.forYou.rawValue, accountID: accountID)
		try await store?.beginFullRebuild(accountID: accountID, at: Date(timeIntervalSince1970: 1_000))
		try await store?.saveNavigation(
			ReaderNavigationState(items: [.smart(.unread, unreadCount: 9)], expandedFolderIDs: []),
			accountID: accountID,
		)
		store = nil

		let reopened = OfflineLibraryStore(databaseURL: databaseURL)
		let snapshot = try await reopened.loadSnapshot(accountID: accountID)
		#expect(snapshot.navigation == navigation)
		#expect(snapshot.articlesByCollection[ReaderSection.forYou.rawValue]?.map(\.id) == ["article-1"])
	}

	@Test func firstSnapshotRepairsMissingNavigationAndMembershipsBeforeProjection() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-first-snapshot-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "account-a"
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		try await store.apply(
			try decodePage(
				"""
				{
				  "cursor": "v1:feed",
				  "hasMore": false,
				  "changes": [{
				    "sequence": 1,
				    "entityType": "feed",
				    "entityId": "daily",
				    "operation": "upsert",
				    "changedAt": "2026-08-15T12:00:00.000Z",
				    "payload": {
				      "feedKey": "daily",
				      "streamId": "stream-1",
				      "title": "Daily",
				      "isActive": true,
				      "folders": []
				    }
				  }]
				}
				"""
			),
			accountID: accountID,
		)
		let article = makeArticle(feedKey: "daily", isRead: false)
		let articlePayload = IncrementalSyncPayload(
			feedKey: article.feedKey, streamId: nil, title: article.title, feedURL: nil, siteURL: nil, iconURL: nil,
			isActive: nil, folders: nil, id: article.id, readerId: article.readerId, source: article.source,
			author: article.author, html: article.html, text: article.text, originalURL: article.originalURL,
			receivedAt: article.receivedAt, isRead: article.isRead, isStarred: article.isStarred, isBodyPruned: false,
			itemId: nil, updatedAt: nil, version: nil, mutationId: nil,
		)
		try await store.apply(
			IncrementalSyncPage(
				cursor: "v1:article",
				hasMore: false,
				changes: [
					IncrementalSyncChange(
						sequence: 2, entityType: .article, entityId: article.id, operation: .upsert,
						changedAt: article.receivedAt, payload: articlePayload,
					),
				],
			),
			accountID: accountID,
		)
		try deleteCachedNavigationAndMemberships(in: databaseURL, accountID: accountID)

		let snapshot = try await store.loadSnapshot(accountID: accountID)
		#expect(snapshot.navigation?.item(withID: "stream-1") != nil)
		#expect(snapshot.articlesByCollection["stream-1"]?.map(\.id) == [article.id])
		#expect(snapshot.articlesByCollection[ReaderSection.unread.rawValue]?.map(\.id) == [article.id])
	}

	@Test func deletingTheFinalCachedFeedClearsNavigationSnapshot() async throws {
		let store = OfflineLibraryStore.inMemory()
		let date = Date(timeIntervalSince1970: 1_000)
		let payload = IncrementalSyncPayload(
			feedKey: "daily", streamId: "stream-last", title: "Daily", feedURL: nil, siteURL: nil, iconURL: nil,
			isActive: true, folders: [], id: nil, readerId: nil, source: nil, author: nil, html: nil, text: nil,
			originalURL: nil, receivedAt: nil, isRead: nil, isStarred: nil, isBodyPruned: nil, itemId: nil,
			updatedAt: nil, version: nil, mutationId: nil,
		)
		try await store.apply(
			IncrementalSyncPage(
				cursor: "v1:feed", hasMore: false,
				changes: [IncrementalSyncChange(
					sequence: 1, entityType: .feed, entityId: "daily", operation: .upsert,
					changedAt: date, payload: payload,
				)],
			),
			accountID: "account-a",
		)
		try await store.apply(
			IncrementalSyncPage(
				cursor: "v1:delete", hasMore: false,
				changes: [IncrementalSyncChange(
					sequence: 2, entityType: .feed, entityId: "daily", operation: .delete,
					changedAt: date, payload: nil,
				)],
			),
			accountID: "account-a",
		)

		#expect(try await store.loadSnapshot(accountID: "account-a").navigation == nil)
	}

	@Test func legacyMarkerMigrationPreservesAnExplicitEmptyPage() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-legacy-page-migration-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "account-a"
		var store: OfflineLibraryStore? = OfflineLibraryStore(databaseURL: databaseURL)
		let subscription = makeSubscription(id: "stream-legacy", key: "daily", title: "Daily", folders: [])
		let article = makeArticle(id: "legacy-removed", feedKey: "daily", isRead: true)
		try await store?.saveSubscriptions([subscription], accountID: accountID)
		try await store?.saveNavigation(makeNavigation([subscription]), accountID: accountID)
		try await store?.saveArticles([article], collectionID: subscription.id, accountID: accountID)
		try await store?.saveArticles([], collectionID: subscription.id, accountID: accountID)
		store = nil
		try executeTestSQL("DROP TABLE cached_collection_states", in: databaseURL)
		try executeTestSQL("DROP TABLE cache_collection_state_migrations", in: databaseURL)

		let reopened = OfflineLibraryStore(databaseURL: databaseURL)
		let snapshot = try await reopened.loadSnapshot(accountID: accountID)
		#expect(snapshot.articlesByCollection[subscription.id]?.isEmpty != false)
	}

	@Test func newDatabaseMigrationSentinelDoesNotFreezeSyncProjectionRepair() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-new-db-migration-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "account-a"
		var store: OfflineLibraryStore? = OfflineLibraryStore(databaseURL: databaseURL)
		let feedPayload = IncrementalSyncPayload(
			feedKey: "daily", streamId: "stream-sync", title: "Daily", feedURL: nil, siteURL: nil, iconURL: nil,
			isActive: true, folders: [], id: nil, readerId: nil, source: nil, author: nil, html: nil, text: nil,
			originalURL: nil, receivedAt: nil, isRead: nil, isStarred: nil, isBodyPruned: nil, itemId: nil,
			updatedAt: nil, version: nil, mutationId: nil,
		)
		let article = makeArticle(id: "sync-repair-article", feedKey: "daily", isRead: false)
		let articlePayload = IncrementalSyncPayload(
			feedKey: article.feedKey, streamId: nil, title: article.title, feedURL: nil, siteURL: nil, iconURL: nil,
			isActive: nil, folders: nil, id: article.id, readerId: article.readerId, source: article.source,
			author: article.author, html: article.html, text: article.text, originalURL: article.originalURL,
			receivedAt: article.receivedAt, isRead: article.isRead, isStarred: article.isStarred, isBodyPruned: false,
			itemId: nil, updatedAt: nil, version: nil, mutationId: nil,
		)
		try await store?.apply(
			IncrementalSyncPage(
				cursor: "v1:sync", hasMore: false,
				changes: [
					IncrementalSyncChange(sequence: 1, entityType: .feed, entityId: "daily", operation: .upsert, changedAt: article.receivedAt, payload: feedPayload),
					IncrementalSyncChange(sequence: 2, entityType: .article, entityId: article.id, operation: .upsert, changedAt: article.receivedAt, payload: articlePayload),
				],
			),
			accountID: accountID,
		)
		try executeTestSQL(
			"DELETE FROM cached_collection_articles WHERE account_id = 'account-a' AND collection_id = 'stream-sync'",
			in: databaseURL,
		)
		store = nil

		let reopened = OfflineLibraryStore(databaseURL: databaseURL)
		let snapshot = try await reopened.loadSnapshot(accountID: accountID)
		#expect(snapshot.articlesByCollection["stream-sync"]?.map(\.id) == [article.id])
	}

	@Test func membershipRepairPreservesExplicitPageReplacement() async throws {
		let store = OfflineLibraryStore.inMemory()
		let accountID = "account-a"
		let subscription = makeSubscription(id: "stream-page", key: "daily", title: "Daily", folders: [])
		let oldArticle = makeArticle(id: "old-page-article", feedKey: "daily", isRead: true)
		let freshArticle = makeArticle(id: "fresh-page-article", feedKey: "daily", isRead: true)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveNavigation(makeNavigation([subscription]), accountID: accountID)
		try await store.saveArticles([oldArticle], collectionID: subscription.id, accountID: accountID)
		try await store.saveArticles([freshArticle], collectionID: subscription.id, accountID: accountID)

		let snapshot = try await store.loadSnapshot(accountID: accountID)
		#expect(snapshot.articlesByCollection[subscription.id]?.map(\.id) == [freshArticle.id])
	}

	@Test func authoritativeStatusDeltaStillUpdatesManagedMembershipsForExplicitPageArticles() async throws {
		let store = OfflineLibraryStore.inMemory()
		let accountID = "account-a"
		let subscription = makeSubscription(id: "stream-status", key: "daily", title: "Daily", folders: [])
		let article = makeArticle(id: "status-page-article", feedKey: "daily", isRead: false, isStarred: false)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveNavigation(makeNavigation([subscription]), accountID: accountID)
		try await store.saveArticles([article], collectionID: subscription.id, accountID: accountID)
		try await store.apply(
			IncrementalSyncPage(
				cursor: "v1:status", hasMore: false,
				changes: [IncrementalSyncChange(
					sequence: 1, entityType: .status, entityId: article.id, operation: .upsert,
					changedAt: article.receivedAt,
					payload: IncrementalSyncPayload(
						feedKey: nil, streamId: nil, title: nil, feedURL: nil, siteURL: nil, iconURL: nil,
						isActive: nil, folders: nil, id: nil, readerId: nil, source: nil, author: nil, html: nil, text: nil,
						originalURL: nil, receivedAt: nil, isRead: true, isStarred: true, isBodyPruned: nil,
						itemId: article.id, updatedAt: nil, version: nil, mutationId: nil,
					),
				)],
			),
			accountID: accountID,
		)

		let snapshot = try await store.loadSnapshot(accountID: accountID)
		#expect(snapshot.articlesByCollection[subscription.id]?.map(\.id) == [article.id])
		#expect(snapshot.articlesByCollection[ReaderSection.unread.rawValue]?.contains(where: { $0.id == article.id }) != true)
		#expect(snapshot.articlesByCollection[ReaderSection.starred.rawValue]?.map(\.id) == [article.id])
	}

	@Test func membershipRepairPreservesExplicitEmptyPageAfterUnsubscribeAndResubscribe() async throws {
		let store = OfflineLibraryStore.inMemory()
		let accountID = "account-a"
		let subscription = makeSubscription(id: "stream-removed", key: "daily", title: "Daily", folders: [])
		let removedArticle = makeArticle(id: "removed-page-article", feedKey: "daily", isRead: true)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveNavigation(makeNavigation([subscription]), accountID: accountID)
		try await store.saveArticles([removedArticle], collectionID: subscription.id, accountID: accountID)
		// An empty response is an intentional page replacement. The article row is
		// retained for body/search recovery, but must not repopulate this page.
		try await store.saveArticles([], collectionID: subscription.id, accountID: accountID)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveNavigation(makeNavigation([subscription]), accountID: accountID)

		let snapshot = try await store.loadSnapshot(accountID: accountID)
		#expect(snapshot.articlesByCollection[subscription.id]?.isEmpty != false)
	}

	@Test func rebuildIntentPromotionUsesPendingSequenceAfterAcknowledgement() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-rebuild-intents-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "account-a"
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		let older = OfflineMutation(
			id: "z-older",
			kind: .setRead,
			itemIds: ["article-stage"],
			value: true,
			scope: .single,
		)
		let newer = OfflineMutation(
			id: "a-newer",
			kind: .setRead,
			itemIds: ["article-stage"],
			value: false,
			scope: .single,
		)
		try await store.enqueue(older, accountID: accountID)
		try await store.beginFullRebuild(accountID: accountID, at: Date(timeIntervalSince1970: 1_000))
		let receivedAt = Date(timeIntervalSince1970: 1_000)
		let feedPayload = IncrementalSyncPayload(
			feedKey: "daily", streamId: "stream-1", title: "Daily", feedURL: nil, siteURL: nil, iconURL: nil,
			isActive: true, folders: [], id: nil, readerId: nil, source: nil, author: nil, html: nil, text: nil,
			originalURL: nil, receivedAt: nil, isRead: nil, isStarred: nil, isBodyPruned: nil, itemId: nil,
			updatedAt: nil, version: nil, mutationId: nil,
		)
		let articlePayload = IncrementalSyncPayload(
			feedKey: "daily", streamId: nil, title: "Staged story", feedURL: nil, siteURL: nil, iconURL: nil,
			isActive: nil, folders: nil, id: "article-stage", readerId: "reader-stage", source: "Daily", author: nil,
			html: "<p>Staged body</p>", text: nil, originalURL: nil, receivedAt: receivedAt, isRead: false,
			isStarred: false, isBodyPruned: false, itemId: nil, updatedAt: nil, version: nil, mutationId: nil,
		)
		try await store.apply(
			IncrementalSyncPage(
				cursor: "v1:staged",
				hasMore: false,
				changes: [
					IncrementalSyncChange(sequence: 1, entityType: .feed, entityId: "daily", operation: .upsert, changedAt: receivedAt, payload: feedPayload),
					IncrementalSyncChange(sequence: 2, entityType: .article, entityId: "article-stage", operation: .upsert, changedAt: receivedAt, payload: articlePayload),
				],
			),
			accountID: accountID,
		)
		try await store.enqueue(newer, accountID: accountID)
		try setRebuildIntentCreatedAt(in: databaseURL, accountID: accountID, timestamp: 2_000)
		// Simulate the replay completing both requests while the rebuild is still
		// running. Their durable rebuild intents must survive outbox removal.
		try await store.markMutationApplied(id: older.id, accountID: accountID)
		try await store.markMutationApplied(id: newer.id, accountID: accountID)
		try await store.saveNavigation(
			ReaderNavigationState(items: [.smart(.unread, unreadCount: 1)], expandedFolderIDs: []),
			accountID: accountID,
		)
		try await store.finishSynchronization(accountID: accountID, at: Date(timeIntervalSince1970: 2_100))

		let snapshot = try await store.loadSnapshot(accountID: accountID)
		let article = try #require(snapshot.articlesByCollection["stream-1"]?.first)
		#expect(article.isRead == false)
		#expect(snapshot.articlesByCollection[ReaderSection.unread.rawValue]?.map(\.id) == ["article-stage"])
		#expect(try await store.pendingMutations(accountID: accountID, limit: 100).isEmpty)
	}

	@Test func fullRebuildPromotionRetainsReadableForYouPageForArticlesStillOnServer() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-rebuild-for-you-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "account-a"
		var store: OfflineLibraryStore? = OfflineLibraryStore(databaseURL: databaseURL)
		let article = makeArticle(id: "for-you-1", feedKey: "daily", isRead: true)
		try await store?.saveNavigation(
			ReaderNavigationState(items: [.smart(.forYou, unreadCount: 0)], expandedFolderIDs: []),
			accountID: accountID,
		)
		try await store?.saveArticles([article], collectionID: ReaderSection.forYou.rawValue, accountID: accountID)
		try await store?.saveCollectionContinuation(
			"for-you-next",
			collectionID: ReaderSection.forYou.rawValue,
			accountID: accountID,
		)
		try await store?.beginFullRebuild(accountID: accountID, at: Date(timeIntervalSince1970: 1_000))
		let receivedAt = Date(timeIntervalSince1970: 1_000)
		let feedPayload = IncrementalSyncPayload(
			feedKey: "daily", streamId: "stream-1", title: "Daily", feedURL: nil, siteURL: nil, iconURL: nil,
			isActive: true, folders: [], id: nil, readerId: nil, source: nil, author: nil, html: nil, text: nil,
			originalURL: nil, receivedAt: nil, isRead: nil, isStarred: nil, isBodyPruned: nil, itemId: nil,
			updatedAt: nil, version: nil, mutationId: nil,
		)
		let articlePayload = IncrementalSyncPayload(
			feedKey: "daily", streamId: nil, title: article.title, feedURL: nil, siteURL: nil, iconURL: nil,
			isActive: nil, folders: nil, id: article.id, readerId: article.readerId, source: article.source, author: article.author,
			html: article.html, text: article.text, originalURL: article.originalURL, receivedAt: receivedAt, isRead: true,
			isStarred: false, isBodyPruned: false, itemId: nil, updatedAt: nil, version: nil, mutationId: nil,
		)
		try await store?.apply(
			IncrementalSyncPage(
				cursor: "v1:for-you",
				hasMore: false,
				changes: [
					IncrementalSyncChange(sequence: 1, entityType: .feed, entityId: "daily", operation: .upsert, changedAt: receivedAt, payload: feedPayload),
					IncrementalSyncChange(sequence: 2, entityType: .article, entityId: article.id, operation: .upsert, changedAt: receivedAt, payload: articlePayload),
				],
			),
			accountID: accountID,
		)
		try await store?.saveNavigation(
			ReaderNavigationState(items: [.smart(.forYou, unreadCount: 0)], expandedFolderIDs: []),
			accountID: accountID,
		)
		try await store?.finishSynchronization(accountID: accountID, at: Date(timeIntervalSince1970: 2_000))
		store = nil

		let reopened = OfflineLibraryStore(databaseURL: databaseURL)
		let snapshot = try await reopened.loadSnapshot(accountID: accountID)
		#expect(snapshot.articlesByCollection[ReaderSection.forYou.rawValue]?.map(\.id) == [article.id])
		#expect(snapshot.articlesByCollection[ReaderSection.forYou.rawValue]?.first?.html == article.html)
		#expect(snapshot.continuationsByCollection[ReaderSection.forYou.rawValue] == "for-you-next")
	}

	@Test(arguments: [false, true])
	func rebuildIntentPromotionResolvesDecimalAndTagAliases(queueUsesTagID: Bool) async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-rebuild-aliases-\(queueUsesTagID)-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "account-a"
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		let rowID: UInt64 = 202
		let decimalID = String(rowID)
		let tagID = "tag:google.com,2005:reader/item/\(String(rowID, radix: 16))"
		let queuedID = queueUsesTagID ? tagID : decimalID
		let storedReaderID = queueUsesTagID ? decimalID : tagID
		let subscription = makeSubscription(id: "stream-1", key: "daily", title: "Daily", folders: [])
		let article = makeArticle(
			id: "article-alias-\(queueUsesTagID)",
			feedKey: "daily",
			readerID: storedReaderID,
			isRead: false,
			isStarred: false,
		)

		let oldRead = OfflineMutation(id: "alias-old-read-\(queueUsesTagID)", kind: .setRead, itemIds: [queuedID], value: false)
		let oldStar = OfflineMutation(id: "alias-old-star-\(queueUsesTagID)", kind: .setStarred, itemIds: [queuedID], value: false)
		try await store.enqueue(oldRead, accountID: accountID)
		try await store.enqueue(oldStar, accountID: accountID)
		try await store.beginFullRebuild(accountID: accountID, at: Date(timeIntervalSince1970: 1_000))
		let newerRead = OfflineMutation(id: "alias-new-read-\(queueUsesTagID)", kind: .setRead, itemIds: [queuedID], value: true)
		let newerStar = OfflineMutation(id: "alias-new-star-\(queueUsesTagID)", kind: .setStarred, itemIds: [queuedID], value: true)
		try await store.enqueue(newerRead, accountID: accountID)
		try await store.enqueue(newerStar, accountID: accountID)

		try await store.apply(
			IncrementalSyncPage(
				cursor: "v1:aliases",
				hasMore: false,
				changes: [
					IncrementalSyncChange(
						sequence: 1,
						entityType: .article,
						entityId: article.id,
						operation: .upsert,
						changedAt: Date(timeIntervalSince1970: 1_100),
						payload: IncrementalSyncPayload(
							feedKey: article.feedKey,
							streamId: subscription.id,
							title: article.title,
							feedURL: nil,
							siteURL: nil,
							iconURL: nil,
							isActive: nil,
							folders: nil,
							id: article.id,
							readerId: article.readerId,
							source: article.source,
							author: article.author,
							html: article.html,
							text: article.text,
							originalURL: article.originalURL,
							receivedAt: article.receivedAt,
							isRead: article.isRead,
							isStarred: article.isStarred,
							isBodyPruned: false,
							itemId: nil,
							updatedAt: nil,
							version: nil,
							mutationId: nil,
						),
					),
				],
			),
			accountID: accountID,
		)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveNavigation(makeNavigation([subscription]), accountID: accountID)

		for mutation in [oldRead, oldStar, newerRead, newerStar] {
			try await store.markMutationApplied(id: mutation.id, accountID: accountID)
		}
		try await store.finishSynchronization(accountID: accountID, at: Date(timeIntervalSince1970: 2_000))

		let snapshot = try await store.loadSnapshot(accountID: accountID)
		let stored = try #require(snapshot.articlesByCollection[subscription.id]?.first)
		#expect(stored.isRead)
		#expect(stored.isStarred)
		#expect(try await store.pendingMutations(accountID: accountID, limit: 100).isEmpty)
	}

	@Test func missingStatusTargetMarksRepairWithoutAdvancingCursor() async throws {
		let store = OfflineLibraryStore.inMemory()
		try await store.apply(
			IncrementalSyncPage(cursor: "v1:previous", hasMore: false, changes: []),
			accountID: "account-a",
		)
		let page = IncrementalSyncPage(
			cursor: "v1:missing-status",
			hasMore: false,
			changes: [
				IncrementalSyncChange(
					sequence: 1,
					entityType: .status,
					entityId: "missing-article",
					operation: .upsert,
					changedAt: Date(timeIntervalSince1970: 1_000),
					payload: IncrementalSyncPayload(
						feedKey: nil, streamId: nil, title: nil, feedURL: nil, siteURL: nil, iconURL: nil,
						isActive: nil, folders: nil, id: nil, readerId: nil, source: nil, author: nil,
						html: nil, text: nil, originalURL: nil, receivedAt: nil, isRead: true,
						isStarred: nil, isBodyPruned: nil, itemId: "missing-article", updatedAt: nil,
						version: nil, mutationId: nil,
					),
				),
			],
		)

		do {
			try await store.apply(page, accountID: "account-a")
			Issue.record("A missing status target should fail the page transaction.")
		} catch let error as OfflineLibraryError {
			#expect(error == .missingStatusTarget("missing-article"))
		}

		let stats = try await store.storageStats(accountID: "account-a")
		let snapshot = try await store.loadSnapshot(accountID: "account-a")
		#expect(stats.cacheState == .needsRepair)
		#expect(snapshot.integrity.invalidChangeCount == 1)
		#expect(snapshot.cursor == "v1:previous")
	}

	@Test func statusBeforeArticleIsResolvedAfterPageArticlesAreApplied() async throws {
		let store = OfflineLibraryStore.inMemory()
		let receivedAt = Date(timeIntervalSince1970: 1_000)
		let articlePayload = IncrementalSyncPayload(
			feedKey: "daily", streamId: nil, title: "Story", feedURL: nil, siteURL: nil, iconURL: nil,
			isActive: nil, folders: nil, id: "article-1", readerId: "reader-1", source: "Daily",
			author: nil, html: "<p>Body</p>", text: nil, originalURL: nil, receivedAt: receivedAt,
			isRead: false, isStarred: false, isBodyPruned: false, itemId: nil, updatedAt: nil,
			version: nil, mutationId: nil,
		)
		let statusPayload = IncrementalSyncPayload(
			feedKey: nil, streamId: nil, title: nil, feedURL: nil, siteURL: nil, iconURL: nil,
			isActive: nil, folders: nil, id: nil, readerId: nil, source: nil, author: nil,
			html: nil, text: nil, originalURL: nil, receivedAt: nil, isRead: true,
			isStarred: true, isBodyPruned: nil, itemId: "article-1", updatedAt: nil,
			version: 2, mutationId: nil,
		)
		try await store.apply(
			IncrementalSyncPage(
				cursor: "v1:status-after",
				hasMore: false,
				changes: [
					IncrementalSyncChange(sequence: 2, entityType: .status, entityId: "article-1", operation: .upsert, changedAt: receivedAt, payload: statusPayload),
					IncrementalSyncChange(sequence: 1, entityType: .article, entityId: "article-1", operation: .upsert, changedAt: receivedAt, payload: articlePayload),
				],
			),
			accountID: "account-a",
		)

		let article = try #require(
			try await store.searchArticles(query: "Story", collectionID: nil, accountID: "account-a", limit: 10).first,
		)
		#expect(article.isRead)
		#expect(article.isStarred)
	}

	@Test func finalizationRequiresAuthoritativeNavigationAndRecordsSuccess() async throws {
		let store = OfflineLibraryStore.inMemory()
		let success = Date(timeIntervalSince1970: 2_000)
		try await store.beginFullRebuild(accountID: "account-a", at: Date(timeIntervalSince1970: 1_000))
		try await store.apply(
			IncrementalSyncPage(cursor: "v1:final", hasMore: false, changes: []),
			accountID: "account-a",
		)

		do {
			try await store.finishSynchronization(accountID: "account-a", at: success)
			Issue.record("Finalization without navigation should fail.")
		} catch let error as OfflineLibraryError {
			#expect(error == .navigationUnavailable)
		}
		#expect((try await store.storageStats(accountID: "account-a")).cacheState == .needsRepair)

		try await store.saveNavigation(
			ReaderNavigationState(items: [.smart(.forYou, unreadCount: 0)], expandedFolderIDs: []),
			accountID: "account-a",
		)
		try await store.finishSynchronization(accountID: "account-a", at: success)
		let stats = try await store.storageStats(accountID: "account-a")
		#expect(stats.cacheState == .complete)
		#expect(stats.navigationFreshness == .authoritative)
		#expect(stats.lastSuccessAt == success)
		#expect(stats.lastSyncAt == success)
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

	@Test func feedFolderMoveClearsOldFolderMembershipsAndRebuildsTheNewFolderOffline() async throws {
		let store = OfflineLibraryStore.inMemory()
		let accountID = "account-a"
		let subscription = makeSubscription(
			id: "feed/7",
			key: "daily",
			title: "Daily Brief",
			folders: ["Old"],
		)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveNavigation(makeNavigation([subscription]), accountID: accountID)
		let article = makeArticle(id: "folder-story", feedKey: "daily", isRead: false)
		let oldFolderID = "user/-/label/Old"
		let oldChildID = "feed/7::\(oldFolderID)"
		try await store.saveArticles([article], collectionID: oldFolderID, accountID: accountID)
		try await store.saveArticles([article], collectionID: oldChildID, accountID: accountID)
		try await store.saveCollectionContinuation("old-folder-next", collectionID: oldFolderID, accountID: accountID)
		try await store.saveCollectionContinuation("old-child-next", collectionID: oldChildID, accountID: accountID)

		let move = try decodePage(
			"""
			{
			  "cursor": "v1:move",
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
			      "isActive": true,
			      "folders": ["New"]
			    }
			  }]
			}
			"""
		)
		try await store.apply(move, accountID: accountID)

		let snapshot = try await store.loadSnapshot(accountID: accountID)
		let newFolderID = "user/-/label/New"
		let newChildID = "feed/7::\(newFolderID)"
		#expect((snapshot.articlesByCollection[oldFolderID] ?? []).isEmpty)
		#expect((snapshot.articlesByCollection[oldChildID] ?? []).isEmpty)
		#expect(snapshot.continuationsByCollection[oldFolderID] == nil)
		#expect(snapshot.continuationsByCollection[oldChildID] == nil)
		#expect(snapshot.articlesByCollection[newFolderID]?.map(\.id) == [article.id])
		#expect(snapshot.articlesByCollection[newChildID]?.map(\.id) == [article.id])
		#expect(snapshot.navigation?.item(withID: oldChildID) == nil)
		#expect(snapshot.navigation?.item(withID: newChildID) != nil)
	}

	@Test func incrementalArticleUpsertAddsFolderAndChildMembershipsFromCachedSubscriptions() async throws {
		let store = OfflineLibraryStore.inMemory()
		let accountID = "account-a"
		let subscription = makeSubscription(
			id: "feed/7",
			key: "daily",
			title: "Daily Brief",
			folders: ["News"],
		)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveNavigation(makeNavigation([subscription]), accountID: accountID)
		try await store.apply(
			try decodePage(
				"""
				{
				  "cursor": "v1:feed",
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
				      "isActive": true,
				      "folders": ["News"]
				    }
				  }]
				}
				"""
			),
			accountID: accountID,
		)

		let articlePage = try decodePage(
			"""
			{
			  "cursor": "v1:article",
			  "hasMore": false,
			  "changes": [{
			    "sequence": 2,
			    "entityType": "article",
			    "entityId": "article-2",
			    "operation": "upsert",
			    "changedAt": "2026-08-15T12:01:00.000Z",
			    "payload": {
			      "id": "article-2",
			      "readerId": "reader-2",
			      "feedKey": "daily",
			      "source": "Daily",
			      "title": "New folder story",
			      "html": "<p>Body</p>",
			      "receivedAt": "2026-08-15T11:00:00.000Z",
			      "isRead": false,
			      "isStarred": false
			    }
			  }]
			}
			"""
		)
		try await store.apply(articlePage, accountID: accountID)

		let snapshot = try await store.loadSnapshot(accountID: accountID)
		let folderID = "user/-/label/News"
		let childID = "feed/7::\(folderID)"
		#expect(snapshot.articlesByCollection[folderID]?.map(\.id) == ["article-2"])
		#expect(snapshot.articlesByCollection[childID]?.map(\.id) == ["article-2"])
	}

	@Test func recommendationAndFeedCopiesWithOneReaderIDShareStateMembershipsAndSearchResults() async throws {
		let store = OfflineLibraryStore.inMemory()
		let accountID = "account-a"
		let subscription = makeSubscription(
			id: "feed/7",
			key: "daily",
			title: "Daily Brief",
			folders: ["News"],
		)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveNavigation(makeNavigation([subscription]), accountID: accountID)
		let readerID = "tag:google.com,2005:reader/item/shared"
		let canonical = makeArticle(
			id: "canonical-uuid",
			feedKey: "daily",
			readerID: readerID,
			isRead: false,
		)
		let gReaderCopy = makeArticle(
			id: readerID,
			feedKey: "daily",
			readerID: readerID,
			isRead: false,
		)
		try await store.saveArticles([canonical], collectionID: ReaderSection.forYou.rawValue, accountID: accountID)
		try await store.saveArticles([gReaderCopy], collectionID: "feed/7::user/-/label/News", accountID: accountID)

		let status = try decodePage(
			"""
			{
			  "cursor": "v1:status",
			  "hasMore": false,
			  "changes": [{
			    "sequence": 1,
			    "entityType": "status",
			    "entityId": "\(canonical.id)",
			    "operation": "upsert",
			    "changedAt": "2026-08-15T12:00:00.000Z",
			    "payload": {
			      "itemId": "\(canonical.id)",
			      "isRead": true,
			      "isStarred": true
			    }
			  }]
			}
			"""
		)
		try await store.apply(status, accountID: accountID)

		let snapshot = try await store.loadSnapshot(accountID: accountID)
		let folderArticles = snapshot.articlesByCollection["feed/7::user/-/label/News"] ?? []
		let forYouArticles = snapshot.articlesByCollection[ReaderSection.forYou.rawValue] ?? []
		let search = try await store.searchArticles(
			query: "Story",
			collectionID: nil,
			accountID: accountID,
			limit: 20,
		)
		#expect(forYouArticles.map(\.id) == [canonical.id])
		#expect(folderArticles.map(\.id) == [canonical.id])
		#expect(forYouArticles.first?.isRead == true)
		#expect(forYouArticles.first?.isStarred == true)
		#expect(folderArticles.first?.isRead == true)
		#expect(folderArticles.first?.isStarred == true)
		#expect(search.map(\.id) == [canonical.id])
		#expect(try await store.storageStats(accountID: accountID).articleCount == 1)
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

	@Test func malformedUnreferencedArticleIsMarkedWithoutHidingValidCachedRows() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-malformed-cache-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		let valid = makeArticle(id: "article-valid", feedKey: "daily", isRead: true)
		let malformed = makeArticle(id: "article-malformed", feedKey: "daily", isRead: true)
		try await store.saveArticles([valid, malformed], collectionID: "feed/7", accountID: "account-a")
		try executeTestSQL(
			"UPDATE cached_articles SET payload = X'00' WHERE account_id = 'account-a' AND id = 'article-malformed'",
			in: databaseURL,
		)

		let snapshot = try await store.loadSnapshot(accountID: "account-a")
		#expect(snapshot.articlesByCollection["feed/7"]?.map(\.id) == [valid.id])
		#expect(snapshot.integrity.state == .needsRepair)
		#expect(snapshot.integrity.lastError?.contains("malformed") == true)
	}

	@Test func malformedDuplicateArticleDoesNotAbortSnapshotReconciliation() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-malformed-duplicate-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		let article = makeArticle(
			id: "article-duplicate-valid",
			readerID: "reader-duplicate",
			isRead: true,
		)
		try await store.saveArticles([article], collectionID: "feed/duplicate", accountID: "account-a")
		try executeTestSQL(
			"""
			INSERT INTO cached_articles
			(account_id, id, reader_id, feed_key, received_at, is_read, is_starred, body_pruned, payload)
			SELECT account_id, 'article-duplicate-bad', reader_id, feed_key, received_at, is_read, is_starred, body_pruned, payload
			FROM cached_articles WHERE account_id = 'account-a' AND id = 'article-duplicate-valid'
			""",
			in: databaseURL,
		)
		try executeTestSQL(
			"UPDATE cached_articles SET payload = X'00' WHERE account_id = 'account-a' AND id = 'article-duplicate-bad'",
			in: databaseURL,
		)

		let snapshot = try await store.loadSnapshot(accountID: "account-a")
		#expect(snapshot.articlesByCollection["feed/duplicate"]?.map(\.id) == [article.id])
		#expect(snapshot.integrity.state == .needsRepair)
	}

	@Test func malformedArticleAndMissingMembershipKeepValidRowsVisible() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-malformed-membership-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "account-a"
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		let subscription = makeSubscription(id: "stream-mixed", key: "daily", title: "Daily", folders: [])
		let valid = makeArticle(id: "article-mixed-valid", feedKey: "daily", receivedAt: 100, isRead: true)
		let malformed = makeArticle(id: "article-mixed-malformed", feedKey: "daily", receivedAt: 90, isRead: false)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveNavigation(makeNavigation([subscription]), accountID: accountID)
		try await store.saveArticles([valid, malformed], collectionID: subscription.id, accountID: accountID)
		try executeTestSQL(
			"UPDATE cached_articles SET payload = X'00' WHERE account_id = 'account-a' AND id = 'article-mixed-malformed'",
			in: databaseURL,
		)
		// The unread projection is deliberately absent. Snapshot repair therefore
		// attempts a full membership rebuild, which must roll back on the malformed
		// article before the tolerant projection reads the valid feed row.
		let snapshot = try await store.loadSnapshot(accountID: accountID)
		#expect(snapshot.articlesByCollection[subscription.id]?.map(\.id) == [valid.id])
		#expect(snapshot.integrity.state == .needsRepair)
	}

	@Test func benchmarkRepresentativeCacheLoad() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-cache-benchmark-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "benchmark-account"
		let feedCount = 52
		let articleCount = 5_344
		let unreadCount = 1_876
		let retainedReadBodyCount = 500
		let retainedBodyCount = unreadCount + retainedReadBodyCount
		let retainedBody = String(repeating: "x", count: 25_000)
		let subscriptions = (0..<feedCount).map { index in
			makeSubscription(id: "stream-\(index)", key: "feed-\(index)", title: "Feed \(index)", folders: [])
		}
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		try await store.saveSubscriptions(subscriptions, accountID: accountID)
		try await store.saveNavigation(makeNavigation(subscriptions), accountID: accountID)
		var articlesByFeed = [[Recommendation]](repeating: [], count: feedCount)
		for index in 0..<articleCount {
			let feedIndex = index % feedCount
			let hasRetainedBody = index < retainedBodyCount
			articlesByFeed[feedIndex].append(
				makeArticle(
					id: "benchmark-\(index)",
					feedKey: "feed-\(feedIndex)",
					html: hasRetainedBody ? retainedBody : "",
					receivedAt: TimeInterval(1_000 + index),
					isRead: index >= unreadCount,
				),
			)
		}
		for (feedIndex, articles) in articlesByFeed.enumerated() {
			try await store.saveArticles(articles, collectionID: "stream-\(feedIndex)", accountID: accountID)
		}
		try executeTestSQL(
			"""
			UPDATE cached_articles
			SET body_pruned = CASE
				WHEN CAST(substr(id, 11) AS INTEGER) < \(retainedBodyCount) THEN 0
				ELSE 1
			END
			WHERE account_id = 'benchmark-account'
			""",
			in: databaseURL,
		)
		try executeTestSQL(
			"""
			INSERT OR IGNORE INTO cached_collection_articles (account_id, collection_id, article_id, position)
			SELECT account_id, 'unread', id, 0
			FROM cached_articles
			WHERE account_id = 'benchmark-account' AND is_read = 0
			""",
			in: databaseURL,
		)

		let stats = try await store.storageStats(accountID: accountID)
		let bootstrapStore = OfflineLibraryBootstrapFileStore(databaseURL: databaseURL)
		await store.resetSnapshotArticleDecodeCount()
		let bootstrapStart = DispatchTime.now().uptimeNanoseconds
		let bootstrap = try #require(bootstrapStore.loadBootstrapSnapshot(accountID: accountID))
		let bootstrapMilliseconds = Double(DispatchTime.now().uptimeNanoseconds - bootstrapStart) / 1_000_000
		let sidecarURL = databaseURL.deletingLastPathComponent()
			.appending(path: "\(databaseURL.lastPathComponent).bootstrap.json")
		let sidecarBytes = try Data(contentsOf: sidecarURL).count
		let bootstrapArticleDecodes = await store.snapshotArticleDecodeCountForTesting()
		print("BOOTSTRAP_BENCH articles=\(stats.articleCount) feeds=\(feedCount) payloadBytes=\(stats.bodyBytes) sidecarBytes=\(sidecarBytes) elapsedMs=\(bootstrapMilliseconds) decoded=\(bootstrapArticleDecodes)")
		#expect(bootstrap.navigation?.items.count == feedCount + ReaderSection.allCases.count)
		#expect(bootstrap.subscriptions.count == feedCount)
		#expect(sidecarBytes <= OfflineLibraryBootstrapSnapshot.maximumEncodedByteCount)
		#expect(bootstrapArticleDecodes == 0)
		await store.resetSnapshotArticleDecodeCount()
		let healthyStart = DispatchTime.now().uptimeNanoseconds
		let healthy = try await store.loadSnapshot(accountID: accountID)
		let healthyMilliseconds = Double(DispatchTime.now().uptimeNanoseconds - healthyStart) / 1_000_000
		let healthyArticleIDs = Set(healthy.articlesByCollection.values.flatMap { $0.map(\.id) })
		print("CACHE_BENCH healthy articles=\(stats.articleCount) feeds=\(feedCount) unread=\(unreadCount) payloadBytes=\(stats.bodyBytes) retainedBodyBytes=\(retainedBodyCount * retainedBody.count) retainedReadBodies=\(retainedReadBodyCount) prunedBodies=\(articleCount - retainedBodyCount) elapsedMs=\(healthyMilliseconds) decoded=\(await store.snapshotArticleDecodeCountForTesting())")
		#expect(stats.articleCount == articleCount)
		#expect(healthyArticleIDs.count == articleCount)
		#expect(healthy.articlesByCollection[ReaderSection.unread.rawValue]?.count == unreadCount)

		try executeTestSQL(
			"DELETE FROM cached_collection_articles WHERE account_id = 'benchmark-account' AND collection_id = 'unread'",
			in: databaseURL,
		)
		await store.resetSnapshotArticleDecodeCount()
		let repairStart = DispatchTime.now().uptimeNanoseconds
		let repaired = try await store.loadSnapshot(accountID: accountID)
		let repairMilliseconds = Double(DispatchTime.now().uptimeNanoseconds - repairStart) / 1_000_000
		let repairedArticleIDs = Set(repaired.articlesByCollection.values.flatMap { $0.map(\.id) })
		print("CACHE_BENCH repair articles=\(stats.articleCount) feeds=\(feedCount) unread=\(unreadCount) payloadBytes=\(stats.bodyBytes) retainedBodyBytes=\(retainedBodyCount * retainedBody.count) retainedReadBodies=\(retainedReadBodyCount) prunedBodies=\(articleCount - retainedBodyCount) elapsedMs=\(repairMilliseconds) decoded=\(await store.snapshotArticleDecodeCountForTesting())")
		#expect(repairedArticleIDs.count == articleCount)
		#expect(repaired.articlesByCollection[ReaderSection.unread.rawValue]?.count == unreadCount)
	}

	@Test func malformedNavigationAndRestorationDoNotHideValidCachedArticles() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-malformed-state-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		let article = makeArticle(id: "article-valid-state", feedKey: "daily", isRead: true)
		let restoration = ReaderRestorationState(
			selectedNavigationID: ReaderSection.forYou.rawValue,
			selectedArticleIDs: [ReaderSection.forYou.rawValue: article.id],
			sortOrders: [:],
			articleFilters: [:],
			sidebarFilter: ReaderSidebarFilter.all.rawValue,
			expandedFolderIDs: [],
			compactColumn: .content,
			readerModes: [:],
			articleScrollOffsets: [:],
		)
		try await store.saveNavigation(
			ReaderNavigationState(items: [.smart(.forYou, unreadCount: 0)], expandedFolderIDs: []),
			accountID: "account-a",
		)
		try await store.saveArticles([article], collectionID: ReaderSection.forYou.rawValue, accountID: "account-a")
		try await store.saveRestoration(restoration, accountID: "account-a")
		try executeTestSQL(
			"UPDATE cached_navigation SET payload = X'00' WHERE account_id = 'account-a'",
			in: databaseURL,
		)
		try executeTestSQL(
			"UPDATE reader_state SET payload = X'00' WHERE account_id = 'account-a'",
			in: databaseURL,
		)

		let snapshot = try await store.loadSnapshot(accountID: "account-a")
		#expect(snapshot.navigation == nil)
		#expect(snapshot.restoration == nil)
		#expect(snapshot.articlesByCollection[ReaderSection.forYou.rawValue]?.map(\.id) == [article.id])
		#expect(snapshot.integrity.state == .needsRepair)
	}

	@Test func malformedSubscriptionLeavesOtherCachedRowsReadable() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-malformed-subscription-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		let validSubscription = makeSubscription(id: "stream-valid", key: "daily", title: "Daily", folders: [])
		let malformedSubscription = makeSubscription(id: "stream-bad", key: "bad", title: "Bad", folders: [])
		let article = makeArticle(id: "article-valid-subscription", feedKey: "daily", isRead: true)
		try await store.saveSubscriptions([validSubscription, malformedSubscription], accountID: "account-a")
		try await store.saveNavigation(makeNavigation([validSubscription]), accountID: "account-a")
		try await store.saveArticles([article], collectionID: validSubscription.id, accountID: "account-a")
		try executeTestSQL(
			"UPDATE cached_subscriptions SET payload = X'00' WHERE account_id = 'account-a' AND id = 'stream-bad'",
			in: databaseURL,
		)

		let snapshot = try await store.loadSnapshot(accountID: "account-a")
		#expect(snapshot.subscriptions.map(\.id) == [validSubscription.id])
		#expect(snapshot.articlesByCollection[validSubscription.id]?.map(\.id) == [article.id])
		#expect(snapshot.integrity.state == .needsRepair)
	}

	@Test func membershipRepairWithMalformedSubscriptionKeepsValidRowsReadable() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-membership-rollback-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		let subscription = makeSubscription(id: "stream-valid", key: "daily", title: "Daily", folders: [])
		let article = makeArticle(
			id: "article-membership-rollback",
			feedKey: "daily",
			receivedAt: 100,
			isRead: false,
		)
		let malformedSubscription = makeSubscription(id: "stream-bad", key: "bad", title: "Bad", folders: [])
		try await store.saveSubscriptions([subscription, malformedSubscription], accountID: "account-a")
		try await store.saveNavigation(makeNavigation([subscription]), accountID: "account-a")
		try await store.saveArticles([article], collectionID: subscription.id, accountID: "account-a")
		try executeTestSQL(
			"UPDATE cached_subscriptions SET payload = X'00' WHERE account_id = 'account-a' AND id = 'stream-bad'",
			in: databaseURL,
		)
		try executeTestSQL(
			"DELETE FROM cached_collection_articles WHERE account_id = 'account-a' AND collection_id = 'unread'",
			in: databaseURL,
		)

		let snapshot = try await store.loadSnapshot(accountID: "account-a")
		#expect(snapshot.articlesByCollection[subscription.id]?.map(\.id) == [article.id])
		#expect(snapshot.integrity.state == .needsRepair)
	}

	@Test func membershipRepairRollsBackOnSQLiteFailureBeforeProjectingValidRows() async throws {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-offline-membership-sqlite-rollback-\(UUID().uuidString)", directoryHint: .isDirectory)
		let databaseURL = directory.appending(path: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "account-a"
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		let subscription = makeSubscription(id: "stream-rollback", key: "daily", title: "Daily", folders: [])
		let article = makeArticle(id: "article-membership-sqlite", feedKey: "daily", receivedAt: 100, isRead: false)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveNavigation(makeNavigation([subscription]), accountID: accountID)
		try await store.saveArticles([article], collectionID: subscription.id, accountID: accountID)
		try executeTestSQL(
			"""
			CREATE TRIGGER fail_membership_rebuild
			BEFORE INSERT ON cached_collection_articles
			WHEN NEW.account_id = 'account-a'
			BEGIN
				SELECT RAISE(ABORT, 'test membership insertion failure');
			END
			""",
			in: databaseURL,
		)

		var failed = false
		do {
			_ = try await store.loadSnapshot(accountID: accountID)
		} catch {
			failed = true
		}
		#expect(failed)
		#expect(
			try queryTestInt(
				"SELECT COUNT(*) FROM cached_collection_articles WHERE account_id = 'account-a' AND collection_id = 'stream-rollback' AND article_id = 'article-membership-sqlite'",
				in: databaseURL,
			) == 1
		)

		try executeTestSQL("DROP TRIGGER fail_membership_rebuild", in: databaseURL)
		let repaired = try await store.loadSnapshot(accountID: accountID)
		#expect(repaired.articlesByCollection[subscription.id]?.map(\.id) == [article.id])
		#expect(repaired.articlesByCollection[ReaderSection.unread.rawValue]?.map(\.id) == [article.id])
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
			kind: .setReadBatch,
			itemIds: (0..<200).map { "reader-omitted-\($0)" },
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

	@Test func seededPreviewStoreSearchesOnlyItsAccountAndCollectionAndDoesNotReseed() async throws {
		let collectionID = ReaderSection.forYou.rawValue
		let accountID = "preview-account"
		let article = makeArticle(id: "preview-seed", html: "<p>Calmer preview body</p>", isRead: false)
		let store = OfflineLibraryStore.inMemory(
			seeding: [article],
			collectionID: collectionID,
			accountID: accountID,
		)

		let firstSearch = try await store.searchArticles(
			query: "calmer",
			collectionID: collectionID,
			accountID: accountID,
			limit: 20,
		)
		let wrongCollection = try await store.searchArticles(
			query: "calmer",
			collectionID: "other-collection",
			accountID: accountID,
			limit: 20,
		)
		let wrongAccount = try await store.searchArticles(
			query: "calmer",
			collectionID: collectionID,
			accountID: "other-account",
			limit: 20,
		)

		try await store.saveArticles([], collectionID: collectionID, accountID: accountID)
		let afterRemoval = try await store.searchArticles(
			query: "calmer",
			collectionID: collectionID,
			accountID: accountID,
			limit: 20,
		)

		#expect(firstSearch.map(\.id) == [article.id])
		#expect(wrongCollection.isEmpty)
		#expect(wrongAccount.isEmpty)
		#expect(afterRemoval.isEmpty)
	}

	private func makeArticle(
		id: String = "article-1",
		feedKey: String = "daily",
		readerID: String? = nil,
		score: Int = 80,
		html: String = "<p>Cached body</p>",
		receivedAt: TimeInterval = 300,
		isRead: Bool = true,
		isStarred: Bool = false,
	) -> Recommendation {
		Recommendation(
			id: id,
			readerId: readerID ?? (id == "article-1" ? "reader-1" : "reader-\(id)"),
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

	private func makeSubscription(
		id: String,
		key: String,
		title: String,
		folders: [String],
	) -> FeedSubscription {
		guard let url = URL(string: "https://pigeon.test/feed/\(key)") else {
			preconditionFailure("Invalid test URL")
		}
		return FeedSubscription(
			id: id,
			title: title,
			categories: folders.map { FeedCategory(id: "user/-/label/\($0)", label: $0) },
			url: url,
			htmlUrl: nil,
			iconUrl: nil,
		)
	}

	private func makeNavigation(_ subscriptions: [FeedSubscription]) -> ReaderNavigationState {
		let readerSubscriptions = subscriptions.map { subscription in
			ReaderSubscription(
				id: subscription.id,
				title: subscription.title,
				categories: subscription.categories.map {
					ReaderSubscriptionCategory(id: $0.id, label: $0.label)
				},
				url: subscription.url.absoluteString,
			)
		}
		let feedCounts = subscriptions.map { ReaderUnreadCount(id: $0.id, count: 1) }
		let folderCounts = subscriptions.flatMap { subscription in
			subscription.categories.map { ReaderUnreadCount(id: $0.id, count: 1) }
		}
		return ReaderNavigationCatalog.make(
			subscriptions: readerSubscriptions,
			unreadCounts: feedCounts + folderCounts,
			smartCounts: ReaderNavigationSmartCounts(forYou: 1, today: 1, unread: 1, starred: 0),
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

	private func deleteCachedNavigationAndMemberships(in databaseURL: URL, accountID: String) throws {
		for table in ["cached_navigation_items", "cached_navigation", "cached_collection_articles"] {
			try executeTestSQL("DELETE FROM \(table) WHERE account_id = ?", in: databaseURL, bindings: [accountID])
		}
	}

	private func setRebuildIntentCreatedAt(in databaseURL: URL, accountID: String, timestamp: TimeInterval) throws {
		for table in ["pending_actions", "cache_rebuild_intents"] {
			try executeTestSQL(
				"UPDATE \(table) SET created_at = ? WHERE account_id = ?",
				in: databaseURL,
				bindings: [String(timestamp), accountID],
			)
		}
	}

	private func executeTestSQL(_ sql: String, in databaseURL: URL, bindings: [String] = []) throws {
		var database: OpaquePointer?
		guard sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK,
			let database else {
			throw TestSQLiteError.openFailed
		}
		defer { sqlite3_close(database) }
		var statement: OpaquePointer?
		guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
			let statement else {
			throw TestSQLiteError.prepareFailed
		}
		defer { sqlite3_finalize(statement) }
		for (index, binding) in bindings.enumerated() {
			guard binding.withCString({ sqlite3_bind_text(statement, Int32(index + 1), $0, -1, testSQLiteTransient) }) == SQLITE_OK else {
				throw TestSQLiteError.updateFailed
			}
		}
		guard sqlite3_step(statement) == SQLITE_DONE else {
			throw TestSQLiteError.updateFailed
		}
	}

	private func queryTestInt(_ sql: String, in databaseURL: URL, bindings: [String] = []) throws -> Int {
		var database: OpaquePointer?
		guard sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK,
			let database else {
			throw TestSQLiteError.openFailed
		}
		defer { sqlite3_close(database) }
		var statement: OpaquePointer?
		guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
			let statement else {
			throw TestSQLiteError.prepareFailed
		}
		defer { sqlite3_finalize(statement) }
		for (index, binding) in bindings.enumerated() {
			guard binding.withCString({ sqlite3_bind_text(statement, Int32(index + 1), $0, -1, testSQLiteTransient) }) == SQLITE_OK else {
				throw TestSQLiteError.updateFailed
			}
		}
		guard sqlite3_step(statement) == SQLITE_ROW else {
			throw TestSQLiteError.updateFailed
		}
		return Int(sqlite3_column_int64(statement, 0))
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
