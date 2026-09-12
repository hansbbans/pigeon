import Foundation
import SQLite3
import Testing
@testable import PigeonReader

struct OfflineLibraryBootstrapTests {
	@Test func bootstrapIsMetadataOnlyBoundedAndAccountScoped() async throws {
		let (directory, databaseURL) = try makeDatabaseURL(named: "library.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }

		let accountID = "bootstrap-account"
		let subscription = makeSubscription(id: "feed/alpha", title: "Alpha")
		let navigation = makeNavigation(forYouCount: 7, feed: subscription)
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		try await store.saveNavigation(navigation, accountID: accountID)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveArticles(
			[makeArticle(id: "cached-body")],
			collectionID: subscription.id,
			accountID: accountID,
		)
		try await store.saveRestoration(
			ReaderRestorationState(
				selectedNavigationID: subscription.id,
				selectedArticleIDs: [subscription.id: "cached-body"],
				sortOrders: [subscription.id: ArticleSortOrder.oldest.rawValue],
				articleFilters: [subscription.id: ReaderArticleFilter.read.rawValue],
				sidebarFilter: ReaderSidebarFilter.unread.rawValue,
				expandedFolderIDs: [],
				compactColumn: .content,
				readerModes: [subscription.id: ReaderMode.readerView.rawValue],
				articleScrollOffsets: ["cached-body": 0.4],
			),
			accountID: accountID,
		)

		let bootstrapStore = OfflineLibraryBootstrapFileStore(databaseURL: databaseURL)
		let snapshot = try #require(bootstrapStore.loadBootstrapSnapshot(accountID: accountID))
		#expect(snapshot.navigation == navigation)
		#expect(snapshot.navigation?.item(withID: ReaderSection.forYou.rawValue)?.unreadCount == 7)
		#expect(snapshot.subscriptions == [subscription])
		#expect(snapshot.preferences?.sortOrders[subscription.id] == ArticleSortOrder.oldest.rawValue)
		#expect(snapshot.preferences?.articleFilters[subscription.id] == ReaderArticleFilter.read.rawValue)
		#expect(snapshot.preferences?.sidebarFilter == ReaderSidebarFilter.unread.rawValue)
		#expect(bootstrapStore.loadBootstrapSnapshot(accountID: "other-account") == nil)

		let sidecarURL = databaseURL.deletingLastPathComponent()
			.appending(path: "\(databaseURL.lastPathComponent).bootstrap.json")
		let data = try Data(contentsOf: sidecarURL)
		#expect(data.count <= OfflineLibraryBootstrapSnapshot.maximumEncodedByteCount)
		let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
		#expect(object.keys.contains("articlesByCollection") == false)
		#expect(object.keys.contains("articleCache") == false)
	}

	@Test func legacySQLiteFallbackReadsCountsAndSubscriptionsWithoutDecodingArticles() async throws {
		let (directory, databaseURL) = try makeDatabaseURL(named: "legacy.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }

		let accountID = "legacy-bootstrap-account"
		let subscription = makeSubscription(id: "feed/legacy", title: "Legacy")
		let navigation = makeNavigation(forYouCount: 19, feed: subscription)
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		try await store.saveNavigation(navigation, accountID: accountID)
		try await store.saveSubscriptions([subscription], accountID: accountID)
		try await store.saveArticles(
			[makeArticle(id: "large-cached-body", html: String(repeating: "body ", count: 10_000))],
			collectionID: subscription.id,
			accountID: accountID,
		)

		let sidecarURL = databaseURL.deletingLastPathComponent()
			.appending(path: "\(databaseURL.lastPathComponent).bootstrap.json")
		let bootstrapStore = OfflineLibraryBootstrapFileStore(databaseURL: databaseURL)
		try Data("not-json".utf8).write(to: sidecarURL, options: [.atomic])
		let corruptFallback = try #require(bootstrapStore.loadBootstrapSnapshot(accountID: accountID))
		#expect(corruptFallback.navigation?.item(withID: ReaderSection.forYou.rawValue)?.unreadCount == 19)
		try FileManager.default.removeItem(at: sidecarURL)
		await store.resetSnapshotArticleDecodeCount()

		let started = DispatchTime.now().uptimeNanoseconds
		let snapshot = try #require(
			bootstrapStore.loadBootstrapSnapshot(accountID: accountID),
		)
		let elapsed = DispatchTime.now().uptimeNanoseconds - started

		#expect(snapshot.navigation == navigation)
		#expect(snapshot.navigation?.item(withID: ReaderSection.forYou.rawValue)?.unreadCount == 19)
		#expect(snapshot.subscriptions == [subscription])
		#expect(await store.snapshotArticleDecodeCountForTesting() == 0)
		print(
			"OfflineLibraryBootstrap legacy metadata read: \(String(format: "%.2f", Double(elapsed) / 1_000_000)) ms, articleDecodes=0",
		)
	}

	@Test func subscriptionsWithoutSavedNavigationDoNotProduceFabricatedZeroHomeTotals() async throws {
		let (directory, databaseURL) = try makeDatabaseURL(named: "subscriptions-only.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }

		let accountID = "subscriptions-only-account"
		let subscription = makeSubscription(id: "feed/subscriptions-only", title: "Subscriptions only")
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		try await store.saveSubscriptions([subscription], accountID: accountID)

		// A subscription list without the committed navigation record has no
		// authoritative Home totals. It must remain a normal loading fallback
		// rather than looking like an empty, fully hydrated library.
		let bootstrapStore = OfflineLibraryBootstrapFileStore(databaseURL: databaseURL)
		#expect(bootstrapStore.loadBootstrapSnapshot(accountID: accountID) == nil)
	}

	@Test func bootstrapSidecarsUseTheConfiguredDatabaseFilename() throws {
		let (directory, firstDatabaseURL) = try makeDatabaseURL(named: "first.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let secondDatabaseURL = directory.appending(path: "second.sqlite")
		let first = OfflineLibraryBootstrapFileStore(databaseURL: firstDatabaseURL)
		let second = OfflineLibraryBootstrapFileStore(databaseURL: secondDatabaseURL)
		let firstNavigation = ReaderNavigationState(items: [.smart(.forYou, unreadCount: 3)])
		let secondNavigation = ReaderNavigationState(items: [.smart(.forYou, unreadCount: 8)])

		try first.save(
			OfflineLibraryBootstrapSnapshot(accountID: "first", navigation: firstNavigation),
		)
		try second.save(
			OfflineLibraryBootstrapSnapshot(accountID: "second", navigation: secondNavigation),
		)

		#expect(first.loadBootstrapSnapshot(accountID: "first")?.navigation == firstNavigation)
		#expect(second.loadBootstrapSnapshot(accountID: "second")?.navigation == secondNavigation)
		#expect(first.loadBootstrapSnapshot(accountID: "second") == nil)
		#expect(second.loadBootstrapSnapshot(accountID: "first") == nil)
	}

	@Test func oversizedOrClearedMetadataDoesNotLeaveAStaleBootstrapSidecar() async throws {
		let (directory, databaseURL) = try makeDatabaseURL(named: "clear.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "clear-account"
		let bootstrapStore = OfflineLibraryBootstrapFileStore(databaseURL: databaseURL)
		let valid = OfflineLibraryBootstrapSnapshot(
			accountID: accountID,
			navigation: ReaderNavigationState(items: [.smart(.forYou, unreadCount: 2)]),
		)
		try bootstrapStore.save(valid)

		let oversized = ReaderNavigationState(
			items: (0..<(OfflineLibraryBootstrapSnapshot.maximumNavigationItemCount + 1))
				.map { _ in ReaderNavigationItem.smart(.forYou) },
		)
		#expect(throws: (any Error).self) {
			try bootstrapStore.save(
				OfflineLibraryBootstrapSnapshot(accountID: accountID, navigation: oversized),
			)
		}
		#expect(bootstrapStore.loadBootstrapSnapshot(accountID: accountID) == nil)

		try bootstrapStore.save(valid)
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		try await store.clearCachedArticles(accountID: accountID)
		#expect(bootstrapStore.loadBootstrapSnapshot(accountID: accountID) == nil)
	}

	@Test func staleTodayCountIsZeroedOnLocalDayRolloverWhileOtherCountsRemain() throws {
		let (directory, databaseURL) = try makeDatabaseURL(named: "today.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "today-account"
		let today = ReaderLocalDayBounds.localDay(containing: .now)
		let yesterdayDate = try #require(Calendar.current.date(byAdding: .day, value: -1, to: today.start))
		let yesterday = ReaderLocalDayBounds.localDay(containing: yesterdayDate).start
		let navigation = ReaderNavigationState(
			items: [
				.smart(.forYou, unreadCount: 12),
				.smart(.today, unreadCount: 9),
			],
		)
		let bootstrapStore = OfflineLibraryBootstrapFileStore(databaseURL: databaseURL)
		try bootstrapStore.save(
			OfflineLibraryBootstrapSnapshot(
				accountID: accountID,
				navigation: navigation,
				todayDayStart: yesterday,
			),
		)

		let loaded = try #require(bootstrapStore.loadBootstrapSnapshot(accountID: accountID))
		#expect(loaded.navigation?.item(withID: ReaderSection.forYou.rawValue)?.unreadCount == 12)
		#expect(loaded.navigation?.item(withID: ReaderSection.today.rawValue)?.unreadCount == 0)
		#expect(loaded.todayDayStart == today.start)
	}

	@Test func fullRestoreAndMetadataOnlySavesPreserveTodayDayProvenance() async throws {
		let (directory, databaseURL) = try makeDatabaseURL(named: "today-provenance.sqlite")
		defer { try? FileManager.default.removeItem(at: directory) }
		let accountID = "today-provenance-account"
		let today = ReaderLocalDayBounds.localDay(containing: .now)
		let yesterdayDate = try #require(Calendar.current.date(byAdding: .day, value: -1, to: today.start))
		let yesterday = ReaderLocalDayBounds.localDay(containing: yesterdayDate).start
		let navigation = ReaderNavigationState(
			items: [
				.smart(.forYou, unreadCount: 4),
				.smart(.today, unreadCount: 11),
			],
		)
		let store = OfflineLibraryStore(databaseURL: databaseURL)
		try await store.saveNavigation(navigation, accountID: accountID)
		try setNavigationUpdatedAt(yesterday, databaseURL: databaseURL, accountID: accountID)
		let bootstrapStore = OfflineLibraryBootstrapFileStore(databaseURL: databaseURL)
		try bootstrapStore.save(
			OfflineLibraryBootstrapSnapshot(
				accountID: accountID,
				navigation: navigation,
				todayDayStart: yesterday,
			),
		)

		// A full restore must use the committed navigation timestamp. Subsequent
		// subscription and preference writes must preserve that provenance too.
		_ = try await store.loadSnapshot(accountID: accountID)
		try await store.saveSubscriptions([], accountID: accountID)
		try await store.saveRestoration(.initial, accountID: accountID)

		let loaded = try #require(bootstrapStore.loadBootstrapSnapshot(accountID: accountID))
		#expect(loaded.navigation?.item(withID: ReaderSection.today.rawValue)?.unreadCount == 0)
		#expect(loaded.navigation?.item(withID: ReaderSection.forYou.rawValue)?.unreadCount == 4)
		#expect(loaded.todayDayStart == today.start)
	}

	private func makeDatabaseURL(named name: String) throws -> (URL, URL) {
		let directory = FileManager.default.temporaryDirectory
			.appending(path: "pigeon-bootstrap-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		return (directory, directory.appending(path: name))
	}

	private func makeSubscription(id: String, title: String) -> FeedSubscription {
		guard let url = URL(string: "https://pigeon.test/\(id)") else {
			preconditionFailure("Invalid test URL")
		}
		return FeedSubscription(
			id: id,
			title: title,
			categories: [],
			url: url,
			htmlUrl: nil,
			iconUrl: nil,
		)
	}

	private func makeNavigation(forYouCount: Int, feed: FeedSubscription) -> ReaderNavigationState {
		ReaderNavigationState(
			items: [
				.smart(.forYou, unreadCount: forYouCount),
				ReaderNavigationItem(
					id: feed.id,
					title: feed.title,
					streamID: feed.id,
					kind: .feed,
					unreadCount: forYouCount,
					parentID: nil,
					feedKey: feed.feedKey,
					iconURL: nil,
					smartSection: nil,
				),
			],
		)
	}

	private func makeArticle(id: String, html: String = "<p>Cached body</p>") -> Recommendation {
		Recommendation(
			id: id,
			readerId: "reader-\(id)",
			feedKey: "alpha",
			source: "Alpha",
			title: "Story \(id)",
			html: html,
			text: "Cached body",
			originalURL: URL(string: "https://example.com/\(id)"),
			receivedAt: Date(timeIntervalSince1970: 100),
			isRead: false,
			isStarred: false,
			score: 0,
			confidence: 0,
			sampleCount: 0,
			explanation: "Test",
			learningState: "Test",
		)
	}

	private func setNavigationUpdatedAt(_ date: Date, databaseURL: URL, accountID: String) throws {
		var database: OpaquePointer?
		guard sqlite3_open_v2(databaseURL.path, &database, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK,
			let database else {
			throw TestSQLiteError.openFailed
		}
		defer { sqlite3_close(database) }
		var statement: OpaquePointer?
		guard sqlite3_prepare_v2(
			database,
			"UPDATE cached_navigation SET updated_at = ? WHERE account_id = ?",
			-1,
			&statement,
			nil,
		) == SQLITE_OK,
			let statement else {
			throw TestSQLiteError.prepareFailed
		}
		defer { sqlite3_finalize(statement) }
		guard sqlite3_bind_double(statement, 1, date.timeIntervalSince1970) == SQLITE_OK,
			sqlite3_bind_text(statement, 2, accountID, -1, bootstrapTestSQLiteTransient) == SQLITE_OK,
			sqlite3_step(statement) == SQLITE_DONE else {
			throw TestSQLiteError.stepFailed
		}
	}
}

private enum TestSQLiteError: Error {
	case openFailed
	case prepareFailed
	case stepFailed
}

private nonisolated(unsafe) let bootstrapTestSQLiteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
