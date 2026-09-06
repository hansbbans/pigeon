import Foundation
import SQLite3

actor OfflineLibraryStore: OfflineLibraryStoring {
	static let shared = OfflineLibraryStore()

	private struct PreviewSeed: Sendable {
		let articles: [Recommendation]
		let collectionID: String
		let accountID: String
	}

	private let databaseURL: URL?
	// Access stays actor-confined; unsafe isolation is needed only so deinit can close
	// SQLite's C pointer under Swift 6's nonisolated deinitializer rule.
	nonisolated(unsafe) private var database: OpaquePointer?
	private let encoder: JSONEncoder
	private let decoder: JSONDecoder
	private var previewSeed: PreviewSeed?
	/// Maps a logical account to the uncommitted generation used by a full rebuild.
	///
	/// The mapping is intentionally process-local. A new store instance never treats an
	/// abandoned staging generation as readable data; the committed account rows remain the
	/// only cold-start snapshot until a finish transaction promotes the stage.
	private var stagingAccountIDs: [String: String] = [:]
	private static let rebuildCacheTables = [
		"cached_navigation_items",
		"cached_navigation",
		"cached_subscriptions",
		"cached_feeds",
		"cached_collection_articles",
		"cached_articles",
		"cached_collection_pagination",
		"cached_collection_states",
		"sync_state",
		"cache_integrity",
	]
	#if DEBUG
	private var snapshotArticleDecodeCount = 0
	#endif

	init(databaseURL: URL? = OfflineLibraryStore.defaultDatabaseURL()) {
		self.init(databaseURL: databaseURL, previewSeed: nil)
	}

	private init(databaseURL: URL?, previewSeed: PreviewSeed?) {
		self.databaseURL = databaseURL
		self.previewSeed = previewSeed
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .iso8601
		self.encoder = encoder
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .custom { decoder in
			let container = try decoder.singleValueContainer()
			let value = try container.decode(String.self)
			let fractional = ISO8601DateFormatter()
			fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
			if let date = fractional.date(from: value) { return date }
			let standard = ISO8601DateFormatter()
			standard.formatOptions = [.withInternetDateTime]
			guard let date = standard.date(from: value) else {
				throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected an ISO 8601 date")
			}
			return date
		}
		self.decoder = decoder
	}

	static func inMemory() -> OfflineLibraryStore {
		OfflineLibraryStore(databaseURL: nil)
	}

	#if DEBUG
	static func inMemory(
		seeding articles: [Recommendation],
		collectionID: String,
		accountID: String,
	) -> OfflineLibraryStore {
		OfflineLibraryStore(
			databaseURL: nil,
			previewSeed: PreviewSeed(articles: articles, collectionID: collectionID, accountID: accountID),
		)
	}
	#endif

	deinit {
		if let database {
			sqlite3_close(database)
		}
	}

	func loadSnapshot(accountID: String) throws -> CachedLibrarySnapshot {
		try loadSnapshotFromStorage(accountID: accountID)
	}

	#if DEBUG
	/// Test-only inspection of an in-progress generation. Production reads stay on
	/// the committed account until promotion completes.
	func loadStagedSnapshot(accountID: String) throws -> CachedLibrarySnapshot {
		guard let stagingAccountID = stagingAccountIDs[accountID] else {
			throw OfflineLibraryError.invalidCacheState("The account has no active full-rebuild generation.")
		}
		return try loadSnapshotFromStorage(accountID: stagingAccountID)
	}
	#endif

	private func loadSnapshotFromStorage(accountID: String) throws -> CachedLibrarySnapshot {
		let database = try openDatabase()
		try reconcileArticleIdentities(accountID: accountID, database: database)
		let integrity = try loadCacheIntegrity(accountID: accountID, database: database)
		var malformedPayload = false
		let navigation: ReaderNavigationState?
		do {
			navigation = try loadSinglePayload(
				ReaderNavigationState.self,
				sql: "SELECT payload FROM cached_navigation WHERE account_id = ?",
				bindings: [.text(accountID)],
				database: database,
			)
		} catch {
			// Keep the rest of the valid cache available. A bad navigation blob must
			// request repair instead of making a cold launch fail before it can render
			// cached stories.
			malformedPayload = true
			navigation = nil
		}
		let subscriptionRowCount = try scalarCount(
			"SELECT COUNT(*) FROM cached_subscriptions WHERE account_id = ?",
			accountID: accountID,
			database: database,
		)
		let subscriptions = try loadPayloads(
			FeedSubscription.self,
			sql: "SELECT payload FROM cached_subscriptions WHERE account_id = ? ORDER BY title COLLATE NOCASE, id",
			bindings: [.text(accountID)],
			database: database,
		)
		if subscriptions.count != subscriptionRowCount {
			malformedPayload = true
		}
		let restoration: ReaderRestorationState?
		do {
			restoration = try loadSinglePayload(
				ReaderRestorationState.self,
				sql: "SELECT payload FROM reader_state WHERE account_id = ?",
				bindings: [.text(accountID)],
				database: database,
			)
		} catch {
			malformedPayload = true
			restoration = nil
		}
		let syncState = try queryOne(
			"SELECT cursor, last_sync_at FROM sync_state WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			(string(at: 0, statement: statement), date(at: 1, statement: statement))
		}
		var continuationsByCollection: [String: String] = [:]
		try query(
			"SELECT collection_id, continuation FROM cached_collection_pagination WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			guard let collectionID = string(at: 0, statement: statement),
				let continuation = string(at: 1, statement: statement),
				continuation.isEmpty == false else {
				return
			}
			continuationsByCollection[collectionID] = continuation
		}

		// Derive missing navigation and repair its derived membership projection before
		// reading articles. Keep both writes in the same transaction so a malformed row
		// or a disk error cannot leave a half-rebuilt canonical cache behind. The
		// lightweight validator uses the already decoded subscription rows below and
		// article metadata columns; full article payloads are decoded exactly once in the
		// projection pass that follows.
		var derivedNavigation = navigation
		do {
			try transaction(database) {
				// A missing navigation blob can be reconstructed from cached feeds. An
				// existing blob remains the last direct snapshot while its freshness is
				// unverified; feed mutations refresh that blob in their own transaction.
				if derivedNavigation == nil {
					derivedNavigation = try makeNavigationFromCachedFeeds(accountID: accountID, database: database)
				}
				if try validateCachedMemberships(
					accountID: accountID,
					dayBounds: nil,
					subscriptions: subscriptions,
					database: database,
				) == false {
					try rebuildAllMemberships(
						accountID: accountID,
						dayBounds: nil,
						preservingLocalCollections: true,
						subscriptions: subscriptions,
						database: database,
					)
				}
			}
		} catch let error as OfflineLibraryError {
			switch error {
			case .invalidCacheState:
				// The transaction has rolled back. Continue with the committed rows and
				// let the tolerant projection below mark the cache for repair.
				malformedPayload = true
				derivedNavigation = navigation
			default:
				throw error
			}
		}

		var articlesByCollection: [String: [Recommendation]] = [:]
		let articleRowCount = try scalarCount(
			"SELECT COUNT(*) FROM cached_articles WHERE account_id = ?",
			accountID: accountID,
			database: database,
		)
		// Decode every cached article once, including rows that have lost all of their
		// memberships. This detects an invalid payload without dropping valid rows from
		// the first snapshot and avoids repeatedly decoding large HTML blobs when one
		// article appears in several collections.
		var decodedArticlesByID: [String: Recommendation] = [:]
		try query(
			"SELECT id, body_pruned, payload FROM cached_articles WHERE account_id = ? ORDER BY received_at DESC, id",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			guard let articleID = string(at: 0, statement: statement),
				let payload = data(at: 2, statement: statement),
				let decodedArticle = try? decoder.decode(Recommendation.self, from: payload) else {
				malformedPayload = true
				return
			}
			decodedArticlesByID[articleID] = sqlite3_column_int64(statement, 1) != 0
				? decodedArticle.replacingHTML("")
				: decodedArticle
			#if DEBUG
			snapshotArticleDecodeCount += 1
			#endif
		}
		if decodedArticlesByID.count != articleRowCount {
			malformedPayload = true
		}

		var joinedMembershipCount = 0
		try query(
			"""
			SELECT ca.collection_id, ca.article_id
			FROM cached_collection_articles ca
			JOIN cached_articles a
			  ON a.account_id = ca.account_id AND a.id = ca.article_id
			WHERE ca.account_id = ?
			ORDER BY ca.collection_id, ca.position, a.received_at DESC, a.id
			""",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			joinedMembershipCount += 1
			guard let collectionID = string(at: 0, statement: statement),
				let articleID = string(at: 1, statement: statement),
				let article = decodedArticlesByID[articleID] else {
				malformedPayload = true
				return
			}
			articlesByCollection[collectionID, default: []].append(article)
		}
		let persistedMembershipCount = try scalarCount(
			"SELECT COUNT(*) FROM cached_collection_articles WHERE account_id = ?",
			accountID: accountID,
			database: database,
		)
		if joinedMembershipCount != persistedMembershipCount {
			malformedPayload = true
		}

		let resolvedIntegrity: OfflineCacheIntegrity
		if malformedPayload {
			let message = "The offline library contained malformed cached data."
			let alreadyRecorded = integrity.state == .needsRepair && integrity.lastError == message
			resolvedIntegrity = OfflineCacheIntegrity(
				formatVersion: OfflineCacheIntegrity.currentFormatVersion,
				state: .needsRepair,
				navigation: .unverified,
				lastAttemptAt: integrity.lastAttemptAt,
				lastSuccessAt: integrity.lastSuccessAt,
				lastError: message,
				invalidChangeCount: integrity.invalidChangeCount + (alreadyRecorded ? 0 : 1),
				lastPageHasMore: integrity.lastPageHasMore,
			)
			try saveCacheIntegrity(resolvedIntegrity, accountID: accountID, database: database)
		} else {
			resolvedIntegrity = integrity
		}
		return CachedLibrarySnapshot(
			navigation: derivedNavigation,
			subscriptions: subscriptions,
			articlesByCollection: articlesByCollection,
			continuationsByCollection: continuationsByCollection,
			restoration: restoration,
			cursor: syncState?.0,
			lastSyncAt: syncState?.1,
			integrity: resolvedIntegrity,
		)
	}

	func beginFullRebuild(accountID: String, at date: Date = .now) async throws {
		let database = try openDatabase()
		let stagingAccountID = "__pigeon_rebuild__\(UUID().uuidString.lowercased())"
		try transaction(database) {
			let previous = try loadCacheIntegrity(accountID: accountID, database: database)
			if let previousStagingAccountID = try queryOne(
				"SELECT staging_account_id FROM cache_rebuilds WHERE account_id = ?",
				bindings: [.text(accountID)],
				database: database,
				map: { string(at: 0, statement: $0) },
			) ?? nil {
				try deleteStagingRows(accountID: previousStagingAccountID, database: database)
				try execute(
					"DELETE FROM cache_rebuilds WHERE account_id = ?",
					bindings: [.text(accountID)],
					database: database,
				)
			}
			try execute(
				"INSERT INTO cache_rebuilds (account_id, staging_account_id, created_at) VALUES (?, ?, ?)",
				bindings: [.text(accountID), .text(stagingAccountID), .double(date.timeIntervalSince1970)],
				database: database,
			)
			try seedRebuildIntents(
				accountID: accountID,
				stagingAccountID: stagingAccountID,
				database: database,
			)
			try saveCacheIntegrity(
				OfflineCacheIntegrity(
					formatVersion: OfflineCacheIntegrity.currentFormatVersion,
					state: .needsRepair,
					navigation: .unverified,
					lastAttemptAt: date,
					lastSuccessAt: previous.lastSuccessAt,
					lastError: "A full offline rebuild is in progress.",
					invalidChangeCount: previous.invalidChangeCount,
					lastPageHasMore: nil,
				),
				accountID: accountID,
				database: database,
			)
			try saveCacheIntegrity(
				OfflineCacheIntegrity(
					formatVersion: OfflineCacheIntegrity.currentFormatVersion,
					state: .syncing,
					navigation: .unverified,
					lastAttemptAt: date,
					lastSuccessAt: nil,
					lastError: nil,
					invalidChangeCount: previous.invalidChangeCount,
					lastPageHasMore: nil,
				),
				accountID: stagingAccountID,
				database: database,
			)
		}
		stagingAccountIDs[accountID] = stagingAccountID
	}

	/// Stop routing writes for a failed or cancelled rebuild back into its
	/// uncommitted generation. The marker and stage stay durable so a later
	/// beginFullRebuild can clean them up, while the committed account remains the
	/// only snapshot visible to a reopened process.
	func abandonFullRebuild(accountID: String, startedAt: Date) async throws {
		guard let stagingAccountID = stagingAccountIDs[accountID] else { return }
		let database = try openDatabase()
		let marker = try queryOne(
			"SELECT staging_account_id, created_at FROM cache_rebuilds WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			(string(at: 0, statement: statement), sqlite3_column_double(statement, 1))
		}
		guard let marker,
			marker.0 == stagingAccountID,
			marker.1 == startedAt.timeIntervalSince1970 else {
			return
		}
		// Do not remove the marker or staged rows here. They are the durable record
		// of an incomplete generation and are reclaimed atomically by the next begin.
		stagingAccountIDs[accountID] = nil
	}

	func finishSynchronization(
		accountID: String,
		at date: Date = .now,
		dayBounds: ReaderLocalDayBounds? = nil,
	) async throws {
		try finishSynchronization(
			accountID: accountID,
			at: date,
			dayBounds: dayBounds,
			rebuildMemberships: true,
		)
	}

	func finishWarmSynchronization(
		accountID: String,
		at date: Date = .now,
		dayBounds: ReaderLocalDayBounds? = nil,
	) async throws {
		try finishSynchronization(
			accountID: accountID,
			at: date,
			dayBounds: dayBounds,
			rebuildMemberships: false,
		)
	}

	private func finishSynchronization(
		accountID: String,
		at date: Date,
		dayBounds: ReaderLocalDayBounds?,
		rebuildMemberships: Bool,
	) throws {
		let database = try openDatabase()
		let stagingAccountID = stagingAccountIDs[accountID]
		let storageAccountID = stagingAccountID ?? accountID
		try transaction(database) {
			let integrity = try loadCacheIntegrity(accountID: storageAccountID, database: database)
			guard integrity.formatVersion == OfflineCacheIntegrity.currentFormatVersion,
				integrity.state == .syncing || integrity.state == .complete,
				integrity.lastPageHasMore == false else {
				throw OfflineLibraryError.invalidCacheState("The offline library did not reach the end of its sync.")
			}
			guard try scalarCount(
				"SELECT COUNT(*) FROM cached_navigation WHERE account_id = ?",
				accountID: storageAccountID,
				database: database,
			) > 0 else {
				throw OfflineLibraryError.navigationUnavailable
			}
			guard try scalarCount(
				"SELECT COUNT(*) FROM sync_state WHERE account_id = ?",
				accountID: storageAccountID,
				database: database,
			) > 0 else {
				throw OfflineLibraryError.invalidCacheState("The offline library had no persisted sync cursor.")
			}
			if rebuildMemberships {
				try applyPendingStatusOverlay(accountID: accountID, storageAccountID: storageAccountID, database: database)
				try rebuildAllMemberships(accountID: storageAccountID, dayBounds: dayBounds, database: database)
			} else {
				if try validateCachedMemberships(accountID: storageAccountID, dayBounds: dayBounds, database: database) == false {
					try rebuildAllMemberships(accountID: storageAccountID, dayBounds: dayBounds, database: database)
				}
			}
			try execute(
				"UPDATE sync_state SET last_sync_at = ? WHERE account_id = ?",
				bindings: [.double(date.timeIntervalSince1970), .text(storageAccountID)],
				database: database,
			)
			try saveCacheIntegrity(
				OfflineCacheIntegrity(
					formatVersion: OfflineCacheIntegrity.currentFormatVersion,
					state: .complete,
					navigation: .authoritative,
					lastAttemptAt: integrity.lastAttemptAt,
					lastSuccessAt: date,
					lastError: nil,
					invalidChangeCount: integrity.invalidChangeCount,
					lastPageHasMore: false,
				),
				accountID: storageAccountID,
				database: database,
			)
			if let stagingAccountID, rebuildMemberships {
				try promoteStaging(
					accountID: accountID,
					stagingAccountID: stagingAccountID,
					date: date,
					database: database,
				)
			}
		}
		if stagingAccountID != nil, rebuildMemberships {
			stagingAccountIDs[accountID] = nil
		}
	}

	func markDataSynchronizedWithoutNavigation(
		accountID: String,
		at date: Date = .now,
		dayBounds: ReaderLocalDayBounds? = nil,
	) async throws {
		let database = try openDatabase()
		let storageAccountID = stagingAccountIDs[accountID] ?? accountID
		try transaction(database) {
			let previous = try loadCacheIntegrity(accountID: storageAccountID, database: database)
			guard previous.formatVersion == OfflineCacheIntegrity.currentFormatVersion,
				previous.lastPageHasMore == false else {
				throw OfflineLibraryError.invalidCacheState("The offline library did not reach the end of its sync.")
			}
			try applyPendingStatusOverlay(accountID: accountID, storageAccountID: storageAccountID, database: database)
			try rebuildAllMemberships(accountID: storageAccountID, dayBounds: dayBounds, database: database)
			try saveCacheIntegrity(
				OfflineCacheIntegrity(
					formatVersion: OfflineCacheIntegrity.currentFormatVersion,
					state: .complete,
					navigation: .unverified,
					lastAttemptAt: previous.lastAttemptAt ?? date,
					lastSuccessAt: previous.lastSuccessAt,
					lastError: previous.lastError,
					invalidChangeCount: previous.invalidChangeCount,
					lastPageHasMore: false,
				),
				accountID: storageAccountID,
				database: database,
			)
		}
	}

	func markCacheRepairNeeded(accountID: String, message: String, at date: Date = .now) async throws {
		let database = try openDatabase()
		let previous = try loadCacheIntegrity(accountID: accountID, database: database)
		let normalizedMessage = String(message.prefix(500))
		let alreadyRecorded = previous.state == .needsRepair && previous.lastError == normalizedMessage
		try saveCacheIntegrity(
			OfflineCacheIntegrity(
				formatVersion: OfflineCacheIntegrity.currentFormatVersion,
				state: .needsRepair,
				navigation: .unverified,
				lastAttemptAt: date,
				lastSuccessAt: previous.lastSuccessAt,
				lastError: normalizedMessage,
				invalidChangeCount: previous.invalidChangeCount + (alreadyRecorded ? 0 : 1),
				lastPageHasMore: previous.lastPageHasMore,
			),
			accountID: accountID,
			database: database,
		)
	}

	func recordSynchronizationFailure(accountID: String, message: String, at date: Date = .now) async throws {
		let database = try openDatabase()
		let previous = try loadCacheIntegrity(accountID: accountID, database: database)
		guard previous.state != .needsRepair else { return }
		try saveCacheIntegrity(
			OfflineCacheIntegrity(
				formatVersion: previous.formatVersion,
				state: previous.state,
				navigation: previous.navigation,
				lastAttemptAt: date,
				lastSuccessAt: previous.lastSuccessAt,
				lastError: String(message.prefix(500)),
				invalidChangeCount: previous.invalidChangeCount,
				lastPageHasMore: previous.lastPageHasMore,
			),
			accountID: accountID,
			database: database,
		)
	}

	#if DEBUG
	func resetSnapshotArticleDecodeCount() {
		snapshotArticleDecodeCount = 0
	}

	func snapshotArticleDecodeCountForTesting() -> Int {
		snapshotArticleDecodeCount
	}
	#endif

	func saveNavigation(_ navigation: ReaderNavigationState, accountID: String) throws {
		let database = try openDatabase()
		let storageAccountID = stagingAccountIDs[accountID] ?? accountID
		let payload = try encoder.encode(navigation)
		try transaction(database) {
			try writeNavigation(navigation, payload: payload, accountID: storageAccountID, database: database)
		}
	}

	func saveSubscriptions(_ subscriptions: [FeedSubscription], accountID: String) throws {
		let database = try openDatabase()
		let storageAccountID = stagingAccountIDs[accountID] ?? accountID
		try transaction(database) {
			try execute("DELETE FROM cached_subscriptions WHERE account_id = ?", bindings: [.text(storageAccountID)], database: database)
			for subscription in subscriptions {
				try execute(
					"INSERT INTO cached_subscriptions (account_id, id, title, payload) VALUES (?, ?, ?, ?)",
					bindings: [.text(storageAccountID), .text(subscription.id), .text(subscription.title), .blob(try encoder.encode(subscription))],
					database: database,
				)
			}
		}
	}

	func saveArticles(_ articles: [Recommendation], collectionID: String, accountID: String) throws {
		let database = try openDatabase()
		// Selected-page/body hydration is a committed local read cache. Keep it on the
		// canonical account so a failed or cancelled full rebuild cannot hide a body that
		// was successfully read while the rebuild was in flight.
		let storageAccountID = accountID
		try reconcileArticleIdentities(accountID: storageAccountID, database: database)
		try transaction(database) {
			try execute(
				"DELETE FROM cached_collection_articles WHERE account_id = ? AND collection_id = ?",
				bindings: [.text(storageAccountID), .text(collectionID)],
				database: database,
			)
			for (position, article) in articles.enumerated() {
				let storedArticle = try upsertArticle(sanitized(article), accountID: storageAccountID, database: database)
				try insertCollectionMembership(
					accountID: storageAccountID,
					collectionID: collectionID,
					articleID: storedArticle.id,
					position: position,
					database: database,
				)
			}
			// A direct page save owns this collection's membership set. Keep that
			// provenance even when the page is intentionally empty, so a later
			// projection repair cannot refill it from unrelated retained articles.
			try execute(
				"""
				INSERT INTO cached_collection_states (account_id, collection_id, explicit_page, updated_at)
				VALUES (?, ?, 1, ?)
				ON CONFLICT(account_id, collection_id) DO UPDATE SET explicit_page = 1, updated_at = excluded.updated_at
				""",
				bindings: [.text(storageAccountID), .text(collectionID), .double(Date.now.timeIntervalSince1970)],
				database: database,
			)
		}
	}

	func saveCollectionContinuation(_ continuation: String?, collectionID: String, accountID: String) throws {
		let database = try openDatabase()
		// Continuations belong to the directly loaded collection cache. Sync-owned
		// cursor state is staged by apply(_:accountID:), but this path must remain
		// readable if that sync later fails.
		let storageAccountID = accountID
		try transaction(database) {
			if let continuation, continuation.isEmpty == false {
				try execute(
					"""
					INSERT INTO cached_collection_pagination (account_id, collection_id, continuation)
					VALUES (?, ?, ?)
					ON CONFLICT(account_id, collection_id) DO UPDATE SET continuation = excluded.continuation
					""",
						bindings: [.text(storageAccountID), .text(collectionID), .text(continuation)],
					database: database,
				)
			} else {
				try execute(
					"DELETE FROM cached_collection_pagination WHERE account_id = ? AND collection_id = ?",
						bindings: [.text(storageAccountID), .text(collectionID)],
					database: database,
				)
			}
		}
	}

	func saveRestoration(_ restoration: ReaderRestorationState, accountID: String) throws {
		let database = try openDatabase()
		try execute(
			"""
			INSERT INTO reader_state (account_id, payload, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(account_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
			""",
			bindings: [.text(accountID), .blob(try encoder.encode(restoration)), .double(Date.now.timeIntervalSince1970)],
			database: database,
		)
	}

	func enqueue(_ mutation: OfflineMutation, accountID: String) throws {
		let database = try openDatabase()
		let payload = try encoder.encode(mutation)
		let stagingAccountID = stagingAccountIDs[accountID]
		try transaction(database) {
			try execute(
				"""
				INSERT OR IGNORE INTO pending_actions
				(account_id, id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)
				""",
				bindings: [
					.text(accountID), .text(mutation.id), .text(mutation.kind.rawValue),
					.blob(payload), .double(Date.now.timeIntervalSince1970),
				],
				database: database,
			)
			if let stagingAccountID, mutation.isStatusProjection {
				try execute(
					"""
					INSERT OR IGNORE INTO cache_rebuild_intents
					(account_id, staging_account_id, mutation_id, sequence, payload, created_at)
					SELECT ?, ?, id, sequence, payload, created_at
					FROM pending_actions WHERE account_id = ? AND id = ?
					""",
					bindings: [
						.text(accountID), .text(stagingAccountID), .text(accountID), .text(mutation.id),
					],
					database: database,
				)
			}
		}
	}

	func pendingMutations(accountID: String, limit: Int = 100) throws -> [PendingOfflineMutation] {
		let database = try openDatabase()
		var mutations: [PendingOfflineMutation] = []
		try query(
			"""
			SELECT sequence, payload, attempts, last_error, created_at
			FROM pending_actions WHERE account_id = ? ORDER BY sequence LIMIT ?
			""",
			bindings: [.text(accountID), .int64(Int64(max(1, limit)))],
			database: database,
		) { statement in
			guard let payload = data(at: 1, statement: statement),
				let mutation = try? decoder.decode(OfflineMutation.self, from: payload) else {
				return
			}
			mutations.append(
				PendingOfflineMutation(
					sequence: sqlite3_column_int64(statement, 0),
					mutation: mutation,
					attempts: Int(sqlite3_column_int(statement, 2)),
					lastError: string(at: 3, statement: statement),
					createdAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 4)),
				),
			)
		}
		return mutations
	}

	func markMutationApplied(id: String, accountID: String) throws {
		try execute(
			"DELETE FROM pending_actions WHERE account_id = ? AND id = ?",
			bindings: [.text(accountID), .text(id)],
			database: try openDatabase(),
		)
	}

	func recordMutationFailure(id: String, message: String, accountID: String) throws {
		try execute(
			"""
			UPDATE pending_actions SET attempts = attempts + 1, last_error = ?
			WHERE account_id = ? AND id = ?
			""",
			bindings: [.text(String(message.prefix(500))), .text(accountID), .text(id)],
			database: try openDatabase(),
		)
	}

	func apply(_ page: IncrementalSyncPage, accountID: String) async throws {
		try await apply(page, accountID: accountID, dayBounds: nil)
	}

	func apply(
		_ page: IncrementalSyncPage,
		accountID: String,
		dayBounds: ReaderLocalDayBounds?,
	) async throws {
		let database = try openDatabase()
		let storageAccountID = stagingAccountIDs[accountID] ?? accountID
		do {
			try transaction(database) {
				guard page.cursor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
					throw OfflineLibraryError.invalidSyncChange("The sync page had no cursor.")
				}
				let previous = try loadCacheIntegrity(accountID: storageAccountID, database: database)
				try saveCacheIntegrity(
					OfflineCacheIntegrity(
						formatVersion: OfflineCacheIntegrity.currentFormatVersion,
						state: .syncing,
						navigation: .unverified,
						lastAttemptAt: previous.lastAttemptAt ?? .now,
						lastSuccessAt: previous.lastSuccessAt,
						lastError: nil,
						invalidChangeCount: previous.invalidChangeCount,
						lastPageHasMore: page.hasMore,
					),
					accountID: storageAccountID,
					database: database,
				)

				let deletedArticleIDs = Set(
					page.changes
						.filter { $0.entityType == .article && $0.operation == .delete }
						.map(\.entityId),
				)
				// Article/feed upserts must land before status changes because a page can
				// contain both records for a newly-created article.
				for change in page.changes where change.entityType != .status {
					try apply(
						change,
						accountID: storageAccountID,
						dayBounds: dayBounds,
						deletedArticleIDs: deletedArticleIDs,
						database: database,
					)
				}
				for change in page.changes where change.entityType == .status {
					try apply(
						change,
						accountID: storageAccountID,
						dayBounds: dayBounds,
						deletedArticleIDs: deletedArticleIDs,
						database: database,
					)
				}
				try execute(
					"""
					INSERT INTO sync_state (account_id, cursor, last_sync_at) VALUES (?, ?, NULL)
					ON CONFLICT(account_id) DO UPDATE SET cursor = excluded.cursor
					""",
					bindings: [.text(storageAccountID), .text(page.cursor)],
					database: database,
				)
			}
		} catch {
			// The page transaction rolls back both rows and cursor. Keep a separate
			// repair marker so a next launch cannot trust the previous cursor.
			try? await markCacheRepairNeeded(accountID: accountID, message: error.localizedDescription)
			throw error
		}
	}

	func storageStats(accountID: String) throws -> OfflineStorageStats {
		let database = try openDatabase()
		try reconcileArticleIdentities(accountID: accountID, database: database)
		let article = try queryOne(
			"SELECT COUNT(*), COALESCE(SUM(LENGTH(payload)), 0) FROM cached_articles WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			(Int(sqlite3_column_int64(statement, 0)), sqlite3_column_int64(statement, 1))
		} ?? (0, 0)
		let pending = try queryOne(
			"SELECT COUNT(*) FROM pending_actions WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		) { Int(sqlite3_column_int64($0, 0)) } ?? 0
		let lastSync = try queryOne(
			"SELECT last_sync_at FROM sync_state WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		) { date(at: 0, statement: $0) } ?? nil
		let integrity = try loadCacheIntegrity(accountID: accountID, database: database)
		return OfflineStorageStats(
			articleCount: article.0,
			bodyBytes: article.1,
			pendingMutationCount: pending,
			lastSyncAt: lastSync,
			cacheState: integrity.state,
			navigationFreshness: integrity.navigation,
			lastAttemptAt: integrity.lastAttemptAt,
			lastSuccessAt: integrity.lastSuccessAt,
			lastError: integrity.lastError,
		)
	}

	func cleanupReadBodies(accountID: String, keepingNewest count: Int = 200) throws -> Int {
		let database = try openDatabase()
		// Incremental/full sync invokes this after applying pages. Keep its pruning
		// inside the in-progress generation so canonical bodies remain available if
		// the rebuild is interrupted.
		let storageAccountID = stagingAccountIDs[accountID] ?? accountID
		try reconcileArticleIdentities(accountID: storageAccountID, database: database)
		var candidates: [(String, Recommendation)] = []
		try query(
			"""
			SELECT id, payload FROM cached_articles
			WHERE account_id = ? AND is_read = 1 AND is_starred = 0
			ORDER BY received_at DESC LIMIT -1 OFFSET ?
			""",
			bindings: [.text(storageAccountID), .int64(Int64(max(count, 0)))],
			database: database,
		) { statement in
			guard let id = string(at: 0, statement: statement),
				let payload = data(at: 1, statement: statement),
				let article = try? decoder.decode(Recommendation.self, from: payload),
				article.html.isEmpty == false else { return }
			candidates.append((id, article))
		}
		try transaction(database) {
			for (id, article) in candidates {
				let pruned = Recommendation(
					id: article.id, readerId: article.readerId, feedKey: article.feedKey,
					source: article.source, author: article.author, title: article.title, html: "", text: article.text,
					originalURL: article.originalURL, receivedAt: article.receivedAt,
					isRead: article.isRead, isStarred: article.isStarred, score: article.score,
					confidence: article.confidence, sampleCount: article.sampleCount,
					explanation: article.explanation, learningState: article.learningState,
				)
				try execute(
					"UPDATE cached_articles SET payload = ?, body_pruned = 1 WHERE account_id = ? AND id = ?",
					bindings: [.blob(try encoder.encode(pruned)), .text(storageAccountID), .text(id)],
					database: database,
				)
			}
		}
		return candidates.count
	}

	func clearCachedArticles(accountID: String) throws {
		let database = try openDatabase()
		let storageAccountID = accountID
		try transaction(database) {
			try execute("DELETE FROM cached_collection_articles WHERE account_id = ?", bindings: [.text(storageAccountID)], database: database)
			try execute("DELETE FROM cached_articles WHERE account_id = ?", bindings: [.text(storageAccountID)], database: database)
			try execute("DELETE FROM cached_collection_pagination WHERE account_id = ?", bindings: [.text(storageAccountID)], database: database)
			try execute("DELETE FROM cached_collection_states WHERE account_id = ?", bindings: [.text(storageAccountID)], database: database)
			try execute("DELETE FROM cache_collection_state_migrations WHERE account_id = ?", bindings: [.text(storageAccountID)], database: database)
			try execute("DELETE FROM cached_navigation_items WHERE account_id = ?", bindings: [.text(storageAccountID)], database: database)
			try execute("DELETE FROM cached_navigation WHERE account_id = ?", bindings: [.text(storageAccountID)], database: database)
			try execute("DELETE FROM sync_state WHERE account_id = ?", bindings: [.text(storageAccountID)], database: database)
			try saveCacheIntegrity(
				.needsBootstrap,
				accountID: storageAccountID,
				database: database,
			)
		}
	}

	func searchArticles(
		query rawQuery: String,
		collectionID: String?,
		accountID: String,
		limit: Int = 200,
	) throws -> [Recommendation] {
		let terms = rawQuery
			.split(whereSeparator: { $0.isWhitespace })
			.map(String.init)
			.filter { $0.isEmpty == false }
		guard terms.isEmpty == false else { return [] }
		let database = try openDatabase()
		try reconcileArticleIdentities(accountID: accountID, database: database)
		var candidates: [Recommendation] = []
		let boundedLimit = max(1, min(limit, 500))
		if let collectionID {
			try query(
				"""
				SELECT a.payload FROM cached_collection_articles ca
				JOIN cached_articles a ON a.account_id = ca.account_id AND a.id = ca.article_id
				WHERE ca.account_id = ? AND ca.collection_id = ?
				ORDER BY a.received_at DESC
				""",
				bindings: [.text(accountID), .text(collectionID)],
				database: database,
			) { statement in
				if let payload = data(at: 0, statement: statement),
					let article = try? decoder.decode(Recommendation.self, from: payload) {
					candidates.append(article)
				}
			}
		} else {
			try query(
				"SELECT payload FROM cached_articles WHERE account_id = ? ORDER BY received_at DESC",
				bindings: [.text(accountID)],
				database: database,
			) { statement in
				if let payload = data(at: 0, statement: statement),
					let article = try? decoder.decode(Recommendation.self, from: payload) {
					candidates.append(article)
				}
			}
		}

		return candidates.filter { article in
			let searchable = [
				article.title,
				article.author ?? "",
				article.source,
				article.text ?? "",
				article.html.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression),
			].joined(separator: "\n")
			return terms.allSatisfy { term in
				searchable.range(of: term, options: [.caseInsensitive, .diacriticInsensitive]) != nil
			}
		}.prefix(boundedLimit).map { $0 }
	}

	private func apply(
		_ change: IncrementalSyncChange,
		accountID: String,
		dayBounds: ReaderLocalDayBounds?,
		deletedArticleIDs: Set<String>,
		database: OpaquePointer,
	) throws {
		guard change.entityId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
			throw OfflineLibraryError.invalidSyncChange("The sync change had no entity ID.")
		}
		switch change.entityType {
		case .feed:
			if change.operation == .delete {
				let previousSubscriptions = try cachedSubscriptions(
					feedKey: change.entityId,
					accountID: accountID,
					database: database,
				)
				let previousStreamID = try queryOne(
					"SELECT stream_id FROM cached_feeds WHERE account_id = ? AND feed_key = ?",
					bindings: [.text(accountID), .text(change.entityId)],
					database: database,
					map: { string(at: 0, statement: $0) },
				) ?? nil
				let previousSubscriptionIDs = try cachedSubscriptionIDs(
					feedKey: change.entityId,
					accountID: accountID,
					database: database,
				)
				try execute(
					"DELETE FROM cached_feeds WHERE account_id = ? AND feed_key = ?",
					bindings: [.text(accountID), .text(change.entityId)],
					database: database,
				)
				for subscriptionID in Set(previousSubscriptionIDs + [previousStreamID].compactMap { $0 }) {
					try execute(
						"DELETE FROM cached_subscriptions WHERE account_id = ? AND id = ?",
						bindings: [.text(accountID), .text(subscriptionID)],
						database: database,
					)
				}
				try reconcileFeedMemberships(
					forFeedKeys: Set([change.entityId] + [previousStreamID].compactMap { $0 }),
					previousSubscriptions: previousSubscriptions,
					dayBounds: dayBounds,
					accountID: accountID,
					database: database,
				)
				// Feed changes invalidate navigation folders/order. Rebuild it once in
				// this page transaction so the next cold load sees the current feed rows.
				if try makeNavigationFromCachedFeeds(accountID: accountID, database: database) == nil,
					previousSubscriptions.isEmpty == false || previousStreamID != nil {
					// An explicitly deleted final feed is authoritative. Remove the old
					// navigation fallback instead of leaving a selected, nonexistent feed.
					try clearCachedNavigation(accountID: accountID, database: database)
				}
				return
			}
			let previousSubscriptions = try cachedSubscriptions(
				feedKey: change.entityId,
				accountID: accountID,
				database: database,
			)
			let previousStreamID = try queryOne(
				"SELECT stream_id FROM cached_feeds WHERE account_id = ? AND feed_key = ?",
				bindings: [.text(accountID), .text(change.entityId)],
				database: database,
				map: { string(at: 0, statement: $0) },
			) ?? nil
			let previousSubscriptionIDs = try cachedSubscriptionIDs(
				feedKey: change.entityId,
				accountID: accountID,
				database: database,
			)
			guard change.operation == .upsert, let payload = change.payload,
				let feedKey = payload.feedKey, feedKey.isEmpty == false,
				let streamID = payload.streamId, streamID.isEmpty == false,
				let title = payload.title, title.isEmpty == false else {
				throw OfflineLibraryError.invalidSyncChange("The feed change for \(change.entityId) was malformed.")
			}
			try execute(
				"""
				INSERT INTO cached_feeds
				(account_id, feed_key, stream_id, title, feed_url, site_url, icon_url, is_active, folders_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(account_id, feed_key) DO UPDATE SET
				stream_id = excluded.stream_id, title = excluded.title, feed_url = excluded.feed_url,
				site_url = excluded.site_url, icon_url = excluded.icon_url,
				is_active = excluded.is_active, folders_json = excluded.folders_json
				""",
				bindings: [
					.text(accountID), .text(feedKey), .text(streamID), .text(title),
					.optionalText(payload.feedURL?.absoluteString), .optionalText(payload.siteURL?.absoluteString),
					.optionalText(payload.iconURL?.absoluteString), .int64(payload.isActive == false ? 0 : 1),
					.blob(try encoder.encode(payload.folders ?? [])),
				],
				database: database,
			)
			let staleSubscriptionIDs = Set(previousSubscriptionIDs + [previousStreamID].compactMap { $0 })
				.filter { $0 != streamID }
			for subscriptionID in staleSubscriptionIDs {
				try execute(
					"DELETE FROM cached_subscriptions WHERE account_id = ? AND id = ?",
					bindings: [.text(accountID), .text(subscriptionID)],
					database: database,
				)
			}
			if payload.isActive == false {
				try execute(
					"DELETE FROM cached_subscriptions WHERE account_id = ? AND id = ?",
					bindings: [.text(accountID), .text(streamID)],
					database: database,
				)
			} else if let subscriptionURL = URL(string: "https://offline.invalid/feed/\(feedKey)") {
				let subscription = FeedSubscription(
					id: streamID,
					title: title,
					categories: (payload.folders ?? []).map {
						FeedCategory(id: "user/-/label/\($0)", label: $0)
					},
					url: subscriptionURL,
					sourceUrl: payload.feedURL,
					htmlUrl: payload.siteURL,
					iconUrl: payload.iconURL?.absoluteString,
				)
				try execute(
					"""
					INSERT INTO cached_subscriptions (account_id, id, title, payload) VALUES (?, ?, ?, ?)
					ON CONFLICT(account_id, id) DO UPDATE SET title = excluded.title, payload = excluded.payload
					""",
					bindings: [.text(accountID), .text(streamID), .text(title), .blob(try encoder.encode(subscription))],
					database: database,
				)
			}
			try reconcileFeedMemberships(
				forFeedKeys: Set([change.entityId, feedKey] + [previousStreamID].compactMap { $0 }),
				previousSubscriptions: previousSubscriptions,
				dayBounds: dayBounds,
				accountID: accountID,
				database: database,
			)
			// Keep the persisted navigation blob in step with feed folder changes.
			if try makeNavigationFromCachedFeeds(accountID: accountID, database: database) == nil,
				payload.isActive == false {
				try clearCachedNavigation(accountID: accountID, database: database)
			}
		case .article:
			if change.operation == .delete {
				try deleteArticle(identifier: change.entityId, accountID: accountID, database: database)
				return
			}
			guard change.operation == .upsert, let payload = change.payload,
				let id = payload.id, id.isEmpty == false,
				let readerID = payload.readerId, readerID.isEmpty == false,
				let feedKey = payload.feedKey, feedKey.isEmpty == false,
				let source = payload.source, source.isEmpty == false,
				let title = payload.title, title.isEmpty == false,
				let receivedAt = payload.receivedAt else {
				throw OfflineLibraryError.invalidSyncChange("The article change for \(change.entityId) was malformed.")
			}
			let existing = try loadArticle(identifier: id, accountID: accountID, database: database)
			let serverPrunedBody = payload.isBodyPruned ?? false
			let incomingHTML = payload.html ?? ""
			let shouldPreserveBody = serverPrunedBody
				&& existing?.bodyPruned == false
				&& existing?.article.html.isEmpty == false
			let resolvedHTML = shouldPreserveBody
				? (existing?.article.html ?? "")
				: (serverPrunedBody ? "" : incomingHTML)
			let article = sanitized(Recommendation(
				id: id, readerId: readerID, feedKey: feedKey, source: source, author: payload.author, title: title,
				html: resolvedHTML,
				text: payload.text ?? existing?.article.text,
				originalURL: payload.originalURL ?? existing?.article.originalURL,
				receivedAt: receivedAt, isRead: payload.isRead ?? existing?.article.isRead ?? false,
				isStarred: payload.isStarred ?? existing?.article.isStarred ?? false,
				score: existing?.article.score ?? 0,
				confidence: existing?.article.confidence ?? 0,
				sampleCount: existing?.article.sampleCount ?? 0,
				explanation: existing?.article.explanation ?? "From \(source)",
				learningState: existing?.article.learningState ?? "Synced article",
			))
			let storedArticle = try upsertArticle(
				article,
				bodyPruned: serverPrunedBody && shouldPreserveBody == false,
				accountID: accountID,
				database: database,
			)
			try rebuildMemberships(
				for: storedArticle,
				dayBounds: dayBounds,
				accountID: accountID,
				database: database,
			)
		case .status:
			guard change.operation == .upsert, let payload = change.payload else {
				throw OfflineLibraryError.invalidSyncChange("The status change for \(change.entityId) was malformed.")
			}
			let articleID = payload.itemId ?? change.entityId
			guard articleID.isEmpty == false,
				deletedArticleIDs.contains(articleID) == false,
				payload.isRead != nil || payload.isStarred != nil else {
				throw OfflineLibraryError.invalidSyncChange("The status change for \(change.entityId) was malformed.")
			}
			try updateStatus(
				articleID: articleID,
				isRead: payload.isRead,
				isStarred: payload.isStarred,
				dayBounds: dayBounds,
				accountID: accountID,
				database: database,
			)
		}
	}

	private struct StoredArticle {
		let id: String
		let article: Recommendation
		let bodyPruned: Bool
	}

	private func loadArticle(
		identifier: String,
		accountID: String,
		database: OpaquePointer,
	) throws -> (article: Recommendation, bodyPruned: Bool)? {
		try loadStoredArticles(
			identifier: identifier,
			accountID: accountID,
			database: database,
		).first.map { (article: $0.article, bodyPruned: $0.bodyPruned) }
	}

	private func loadStoredArticles(
		identifier: String? = nil,
		readerID: String? = nil,
		accountID: String,
		database: OpaquePointer,
	) throws -> [StoredArticle] {
		var sql = "SELECT id, payload, body_pruned FROM cached_articles WHERE account_id = ?"
		var bindings: [SQLiteBinding] = [.text(accountID)]
		if let identifier, let readerID {
			sql += " AND (id = ? OR reader_id = ?)"
			bindings += [.text(identifier), .text(readerID)]
			sql += " ORDER BY CASE WHEN id = ? THEN 0 WHEN reader_id = ? THEN 1 ELSE 2 END, id"
			bindings += [.text(identifier), .text(readerID)]
		} else if let identifier {
			sql += " AND (id = ? OR reader_id = ?)"
			bindings += [.text(identifier), .text(identifier)]
			sql += " ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, id"
			bindings.append(.text(identifier))
		} else if let readerID {
			sql += " AND reader_id = ?"
			bindings.append(.text(readerID))
		} else {
			return []
		}
		var articles: [StoredArticle] = []
		try query(sql, bindings: bindings, database: database) { statement in
			guard let id = string(at: 0, statement: statement),
				let payload = data(at: 1, statement: statement) else {
				throw OfflineLibraryError.invalidCacheState("A cached article had no identifier or payload.")
			}
			guard let article = try? decoder.decode(Recommendation.self, from: payload) else {
				throw OfflineLibraryError.invalidCacheState("A cached article had an invalid payload.")
			}
			articles.append(
				StoredArticle(
					id: id,
					article: article,
					bodyPruned: sqlite3_column_int64(statement, 2) != 0,
				),
			)
		}
		return articles
	}

	private func cachedArticles(
		feedKeys: Set<String>,
		accountID: String,
		database: OpaquePointer,
	) throws -> [StoredArticle] {
		guard feedKeys.isEmpty == false else { return [] }
		let placeholders = Array(repeating: "?", count: feedKeys.count).joined(separator: ",")
		var articles: [StoredArticle] = []
		try query(
			"SELECT id, payload, body_pruned FROM cached_articles WHERE account_id = ? AND feed_key IN (\(placeholders))",
			bindings: [.text(accountID)] + feedKeys.sorted().map(SQLiteBinding.text),
			database: database,
		) { statement in
			guard let id = string(at: 0, statement: statement),
				let payload = data(at: 1, statement: statement) else {
				throw OfflineLibraryError.invalidCacheState("A cached article had no identifier or payload.")
			}
			guard let article = try? decoder.decode(Recommendation.self, from: payload) else {
				throw OfflineLibraryError.invalidCacheState("A cached article had an invalid payload.")
			}
			articles.append(
				StoredArticle(
					id: id,
					article: article,
					bodyPruned: sqlite3_column_int64(statement, 2) != 0,
				),
			)
		}
		return articles
	}

	private func cachedSubscriptionIDs(
		feedKey: String,
		accountID: String,
		database: OpaquePointer
	) throws -> [String] {
		try cachedSubscriptions(feedKey: feedKey, accountID: accountID, database: database).map(\.id)
	}

	private func cachedSubscriptions(
		feedKey: String,
		accountID: String,
		database: OpaquePointer,
	) throws -> [FeedSubscription] {
		try cachedSubscriptions(accountID: accountID, database: database).filter {
			$0.feedKey == feedKey || $0.id == feedKey
		}
	}

	private func cachedSubscriptions(
		accountID: String,
		database: OpaquePointer,
	) throws -> [FeedSubscription] {
		var subscriptions: [FeedSubscription] = []
		try query(
			"SELECT payload FROM cached_subscriptions WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			guard let payload = data(at: 0, statement: statement) else {
				throw OfflineLibraryError.invalidCacheState("A cached subscription had no payload.")
			}
			guard let subscription = try? decoder.decode(FeedSubscription.self, from: payload) else {
				throw OfflineLibraryError.invalidCacheState("A cached subscription had an invalid payload.")
			}
			subscriptions.append(subscription)
		}
		return subscriptions
	}

	private func sanitized(_ article: Recommendation) -> Recommendation {
		article.replacingHTML(
			StructuredHTMLSanitizer.sanitize(html: article.html, baseURL: article.safeOriginalURL),
		)
	}

	private func upsertArticle(
		_ article: Recommendation,
		bodyPruned: Bool = false,
		accountID: String,
		database: OpaquePointer,
	) throws -> Recommendation {
		let existing = try loadStoredArticles(
			identifier: article.id,
			readerID: article.readerId,
			accountID: accountID,
			database: database,
		)
		let storageID = preferredArticleID(
			incomingID: article.id,
			readerID: article.readerId,
			existing: existing,
		)
		var storedArticle = articleWithID(article, id: storageID)
		var storedBodyPruned = bodyPruned
		if let existingWithBody = existing.first(where: { $0.article.hasReadableHTML }),
			storedArticle.hasReadableHTML == false {
			storedArticle = storedArticle.replacingHTML(existingWithBody.article.html)
			storedBodyPruned = existingWithBody.bodyPruned
		} else if bodyPruned == true,
			let existingWithBody = existing.first(where: { $0.bodyPruned == false && $0.article.hasReadableHTML }) {
			storedArticle = storedArticle.replacingHTML(existingWithBody.article.html)
			storedBodyPruned = false
		}

		for previous in existing where previous.id != storageID {
			try migrateArticleMemberships(
				from: previous.id,
				to: storageID,
				accountID: accountID,
				database: database,
			)
			try execute(
				"DELETE FROM cached_articles WHERE account_id = ? AND id = ?",
				bindings: [.text(accountID), .text(previous.id)],
				database: database,
			)
		}
		try writeArticle(
			storedArticle,
			bodyPruned: storedBodyPruned,
			accountID: accountID,
			database: database,
		)
		return storedArticle
	}

	private func writeArticle(
		_ article: Recommendation,
		bodyPruned: Bool,
		accountID: String,
		database: OpaquePointer,
	) throws {
		try execute(
			"""
			INSERT INTO cached_articles
			(account_id, id, reader_id, feed_key, received_at, is_read, is_starred, body_pruned, payload)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(account_id, id) DO UPDATE SET
			reader_id = excluded.reader_id, feed_key = excluded.feed_key,
			received_at = excluded.received_at, is_read = excluded.is_read,
			is_starred = excluded.is_starred, body_pruned = excluded.body_pruned,
			payload = excluded.payload
			""",
			bindings: [
				.text(accountID), .text(article.id), .text(article.readerId), .text(article.feedKey),
				.double(article.receivedAt.timeIntervalSince1970), .int64(article.isRead ? 1 : 0),
				.int64(article.isStarred ? 1 : 0), .int64(bodyPruned ? 1 : 0),
				.blob(try encoder.encode(article)),
			],
			database: database,
		)
	}

	private func preferredArticleID(
		incomingID: String,
		readerID: String,
		existing: [StoredArticle],
	) -> String {
		existing.first(where: { $0.id != readerID })?.id
			?? (incomingID == readerID ? existing.first?.id ?? incomingID : incomingID)
	}

	private func articleWithID(_ article: Recommendation, id: String) -> Recommendation {
		Recommendation(
			id: id,
			readerId: article.readerId,
			feedKey: article.feedKey,
			source: article.source,
			author: article.author,
			title: article.title,
			html: article.html,
			text: article.text,
			originalURL: article.originalURL,
			receivedAt: article.receivedAt,
			isRead: article.isRead,
			isStarred: article.isStarred,
			score: article.score,
			confidence: article.confidence,
			sampleCount: article.sampleCount,
			explanation: article.explanation,
			learningState: article.learningState,
		)
	}

	private func migrateArticleMemberships(
		from sourceID: String,
		to destinationID: String,
		accountID: String,
		database: OpaquePointer,
	) throws {
		guard sourceID != destinationID else { return }
		try execute(
			"""
			INSERT INTO cached_collection_articles (account_id, collection_id, article_id, position)
			SELECT account_id, collection_id, ?, position
			FROM cached_collection_articles
			WHERE account_id = ? AND article_id = ?
			ON CONFLICT(account_id, collection_id, article_id) DO UPDATE SET
			position = CASE WHEN cached_collection_articles.position < excluded.position
				THEN cached_collection_articles.position ELSE excluded.position END
			""",
			bindings: [.text(destinationID), .text(accountID), .text(sourceID)],
			database: database,
		)
		try execute(
			"DELETE FROM cached_collection_articles WHERE account_id = ? AND article_id = ?",
			bindings: [.text(accountID), .text(sourceID)],
			database: database,
		)
	}

	private func reconcileArticleIdentities(accountID: String, database: OpaquePointer) throws {
		var duplicateReaderIDs: [String] = []
		try query(
			"""
			SELECT reader_id FROM cached_articles
			WHERE account_id = ? AND reader_id <> ''
			GROUP BY reader_id HAVING COUNT(*) > 1
			""",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			if let readerID = string(at: 0, statement: statement) {
				duplicateReaderIDs.append(readerID)
			}
		}

		for readerID in duplicateReaderIDs {
			// Identity reconciliation runs before the tolerant snapshot decoder. Skip a
			// duplicate group containing a malformed payload so one bad row cannot abort
			// a cold load; the later projection pass will retain valid rows and mark repair.
			var existing: [StoredArticle] = []
			var malformedGroup = false
			try query(
				"SELECT id, body_pruned, payload FROM cached_articles WHERE account_id = ? AND reader_id = ? ORDER BY id",
				bindings: [.text(accountID), .text(readerID)],
				database: database,
			) { statement in
				guard let id = string(at: 0, statement: statement),
					let payload = data(at: 2, statement: statement),
					let article = try? decoder.decode(Recommendation.self, from: payload) else {
					malformedGroup = true
					return
				}
				existing.append(
					StoredArticle(
						id: id,
						article: article,
						bodyPruned: sqlite3_column_int64(statement, 1) != 0,
					),
				)
			}
			guard malformedGroup == false, existing.count > 1 else { continue }
			let storageID = preferredArticleID(
				incomingID: existing[0].id,
				readerID: readerID,
				existing: existing,
			)
			let representative = existing.first(where: { $0.id == storageID }) ?? existing[0]
			var merged = articleWithID(representative.article, id: storageID)
			merged.isRead = existing.contains { $0.article.isRead }
			merged.isStarred = existing.contains { $0.article.isStarred }
			var bodyPruned = representative.bodyPruned
			if representative.article.hasReadableHTML == false,
				let withBody = existing.first(where: { $0.article.hasReadableHTML }) {
				merged = merged.replacingHTML(withBody.article.html)
				bodyPruned = withBody.bodyPruned
			}
			for previous in existing where previous.id != storageID {
				try migrateArticleMemberships(
					from: previous.id,
					to: storageID,
					accountID: accountID,
					database: database,
				)
				try execute(
					"DELETE FROM cached_articles WHERE account_id = ? AND id = ?",
					bindings: [.text(accountID), .text(previous.id)],
					database: database,
				)
			}
			try writeArticle(merged, bodyPruned: bodyPruned, accountID: accountID, database: database)
		}
	}

	private func deleteArticle(identifier: String, accountID: String, database: OpaquePointer) throws {
		let storedArticles = try loadStoredArticles(
			identifier: identifier,
			accountID: accountID,
			database: database,
		)
		for storedArticle in storedArticles {
			try execute(
				"DELETE FROM cached_collection_articles WHERE account_id = ? AND article_id = ?",
				bindings: [.text(accountID), .text(storedArticle.id)],
				database: database,
			)
			try execute(
				"DELETE FROM cached_articles WHERE account_id = ? AND id = ?",
				bindings: [.text(accountID), .text(storedArticle.id)],
				database: database,
			)
		}
	}

	private func collectionIDs(for subscriptions: [FeedSubscription]) -> Set<String> {
		var collectionIDs = Set<String>()
		for subscription in subscriptions {
			let categories = subscription.categories.filter { $0.id.isEmpty == false }
			if categories.isEmpty {
				collectionIDs.insert(subscription.id)
				continue
			}
			for category in categories {
				collectionIDs.insert(category.id)
				collectionIDs.insert("\(subscription.id)::\(category.id)")
			}
		}
		return collectionIDs
	}

	private func feedCollectionIDs(for subscriptions: [FeedSubscription]) -> Set<String> {
		var collectionIDs = Set<String>()
		for subscription in subscriptions {
			let categories = subscription.categories.filter { $0.id.isEmpty == false }
			if categories.isEmpty {
				collectionIDs.insert(subscription.id)
			} else {
				for category in categories {
					collectionIDs.insert("\(subscription.id)::\(category.id)")
				}
			}
		}
		return collectionIDs
	}

	private func cachedNavigationCollectionIDs(
		feedKeys: Set<String>,
		accountID: String,
		database: OpaquePointer,
	) throws -> Set<String> {
		guard feedKeys.isEmpty == false else { return [] }
		let placeholders = Array(repeating: "?", count: feedKeys.count).joined(separator: ",")
		var collectionIDs = Set<String>()
		try query(
			"SELECT id FROM cached_navigation_items WHERE account_id = ? AND feed_key IN (\(placeholders))",
			bindings: [.text(accountID)] + feedKeys.sorted().map(SQLiteBinding.text),
			database: database,
		) { statement in
			if let value = string(at: 0, statement: statement) {
				collectionIDs.insert(value)
			}
		}
		return collectionIDs
	}

	private func cachedExplicitCollectionIDs(accountID: String, database: OpaquePointer) throws -> Set<String> {
		var collectionIDs = Set<String>()
		try query(
			"SELECT collection_id FROM cached_collection_states WHERE account_id = ? AND explicit_page = 1",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			if let collectionID = string(at: 0, statement: statement), collectionID.isEmpty == false {
				collectionIDs.insert(collectionID)
			}
		}
		return collectionIDs
	}

	private func reconcileFeedMemberships(
		forFeedKeys feedKeys: Set<String>,
		previousSubscriptions: [FeedSubscription],
		dayBounds: ReaderLocalDayBounds?,
		accountID: String,
		database: OpaquePointer,
	) throws {
		let activeSubscriptions = try cachedSubscriptions(accountID: accountID, database: database)
		let activeFeedCollectionIDs = feedCollectionIDs(for: activeSubscriptions)
		let activeCollectionIDs = collectionIDs(for: activeSubscriptions)
		var previousFeedCollectionIDs = Set<String>()
		var staleFolderIDs = Set<String>()
		for subscription in previousSubscriptions {
			let categories = subscription.categories.filter { $0.id.isEmpty == false }
			if categories.isEmpty {
				previousFeedCollectionIDs.insert(subscription.id)
			} else {
				for category in categories {
					previousFeedCollectionIDs.insert("\(subscription.id)::\(category.id)")
				}
			}
			for category in categories {
				staleFolderIDs.insert(category.id)
			}
		}
		let staleFeedCollectionIDs = previousFeedCollectionIDs.subtracting(activeFeedCollectionIDs)
		// Per-feed children and removed uncategorized feeds belong exclusively to
		// the changed subscription, so clear their rows even if an article's feed
		// key was already normalized to a newer value. A folder aggregate is shared
		// by subscriptions; clear it only after the last active subscription leaves.
		let staleCollectionIDs = staleFeedCollectionIDs.union(
			staleFolderIDs.filter { activeCollectionIDs.contains($0) == false }
		)
		for collectionID in staleCollectionIDs {
			try execute(
				"DELETE FROM cached_collection_articles WHERE account_id = ? AND collection_id = ?",
				bindings: [.text(accountID), .text(collectionID)],
				database: database,
			)
			try execute(
				"DELETE FROM cached_collection_pagination WHERE account_id = ? AND collection_id = ?",
				bindings: [.text(accountID), .text(collectionID)],
				database: database,
			)
		}
		let previousKeys = previousSubscriptions.reduce(into: Set<String>()) { result, subscription in
			result.insert(subscription.id)
			result.insert(subscription.feedKey)
		}
		let allFeedKeys = feedKeys.union(previousKeys)
		for storedArticle in try cachedArticles(feedKeys: allFeedKeys, accountID: accountID, database: database) {
			let staleSubscriptions = previousSubscriptions.filter {
				$0.id == storedArticle.article.feedKey || $0.feedKey == storedArticle.article.feedKey
			}
			try rebuildMemberships(
				for: storedArticle.article,
				staleSubscriptions: staleSubscriptions,
				dayBounds: dayBounds,
				accountID: accountID,
				database: database,
				)
		}
	}

	private func updateStatus(
		articleID: String,
		isRead: Bool?,
		isStarred: Bool?,
		dayBounds: ReaderLocalDayBounds?,
		accountID: String,
		database: OpaquePointer,
	) throws {
		guard var article = try loadArticle(identifier: articleID, accountID: accountID, database: database)?.article else {
			throw OfflineLibraryError.missingStatusTarget(articleID)
		}
		article.isRead = isRead ?? article.isRead
		article.isStarred = isStarred ?? article.isStarred
		let storedArticle = try upsertArticle(article, accountID: accountID, database: database)
		try rebuildMemberships(
			for: storedArticle,
			dayBounds: dayBounds,
			accountID: accountID,
			database: database,
		)
	}

	private func rebuildMemberships(
		for article: Recommendation,
		staleSubscriptions: [FeedSubscription] = [],
		currentSubscriptions suppliedCurrentSubscriptions: [FeedSubscription]? = nil,
		navigationCollectionIDs suppliedNavigationCollectionIDs: Set<String>? = nil,
		dayBounds: ReaderLocalDayBounds? = nil,
		protectedCollectionIDs: Set<String> = [],
		accountID: String,
		database: OpaquePointer,
	) throws {
		let managedCollections = [ReaderSection.unread.rawValue, ReaderSection.today.rawValue, ReaderSection.starred.rawValue]
		for collectionID in managedCollections where protectedCollectionIDs.contains(collectionID) == false {
			try execute(
				"DELETE FROM cached_collection_articles WHERE account_id = ? AND collection_id = ? AND article_id = ?",
				bindings: [.text(accountID), .text(collectionID), .text(article.id)], database: database,
			)
		}
		if protectedCollectionIDs.contains(ReaderSection.unread.rawValue) == false, article.isRead == false {
			try insertCollectionMembership(accountID: accountID, collectionID: ReaderSection.unread.rawValue, articleID: article.id, position: 0, database: database)
		}
		if protectedCollectionIDs.contains(ReaderSection.today.rawValue) == false,
			(dayBounds ?? ReaderLocalDayBounds.localDay(containing: .now)).contains(article.receivedAt) {
			try insertCollectionMembership(accountID: accountID, collectionID: ReaderSection.today.rawValue, articleID: article.id, position: 0, database: database)
		}
		if protectedCollectionIDs.contains(ReaderSection.starred.rawValue) == false, article.isStarred {
			try insertCollectionMembership(accountID: accountID, collectionID: ReaderSection.starred.rawValue, articleID: article.id, position: 0, database: database)
		}

		let currentSubscriptions: [FeedSubscription]
		if let suppliedCurrentSubscriptions {
			currentSubscriptions = suppliedCurrentSubscriptions
		} else {
			currentSubscriptions = try cachedSubscriptions(
				feedKey: article.feedKey,
				accountID: accountID,
				database: database,
			)
		}
		let currentCollectionIDs = collectionIDs(for: currentSubscriptions).subtracting(protectedCollectionIDs)
		let staleCollectionIDs = collectionIDs(for: staleSubscriptions).subtracting(protectedCollectionIDs)
		let navigationCollectionIDs: Set<String>
		if let suppliedNavigationCollectionIDs {
			navigationCollectionIDs = suppliedNavigationCollectionIDs.subtracting(protectedCollectionIDs)
		} else {
			navigationCollectionIDs = try cachedNavigationCollectionIDs(
				feedKeys: [article.feedKey],
				accountID: accountID,
				database: database,
			).subtracting(protectedCollectionIDs)
		}
		let collectionIDsToClear = currentCollectionIDs
			.union(staleCollectionIDs)
			.union(navigationCollectionIDs)
		for collectionID in collectionIDsToClear {
			try execute(
				"DELETE FROM cached_collection_articles WHERE account_id = ? AND collection_id = ? AND article_id = ?",
				bindings: [.text(accountID), .text(collectionID), .text(article.id)], database: database,
			)
		}
		let collectionIDsToInsert = currentSubscriptions.isEmpty && staleSubscriptions.isEmpty
			? navigationCollectionIDs
			: currentCollectionIDs
		for collectionID in collectionIDsToInsert {
			try insertCollectionMembership(accountID: accountID, collectionID: collectionID, articleID: article.id, position: 0, database: database)
		}
	}

	private func validateCachedMemberships(
		accountID: String,
		dayBounds: ReaderLocalDayBounds?,
		subscriptions suppliedSubscriptions: [FeedSubscription]? = nil,
		database: OpaquePointer,
	) throws -> Bool {
		let orphanCount = try scalarCount(
			"""
			SELECT COUNT(*)
			FROM cached_collection_articles ca
			LEFT JOIN cached_articles a
			  ON a.account_id = ca.account_id AND a.id = ca.article_id
			WHERE ca.account_id = ? AND a.id IS NULL
			""",
			accountID: accountID,
			database: database,
		)
		guard orphanCount == 0 else {
			// An orphaned row is a repairable projection defect. Returning false lets
			// callers rebuild the membership table while retaining every valid article.
			return false
		}

		struct CachedArticleMetadata {
			let id: String
			let feedKey: String
			let receivedAt: Date
			let isRead: Bool
			let isStarred: Bool
		}
		var articles: [CachedArticleMetadata] = []
		try query(
			"SELECT id, feed_key, received_at, is_read, is_starred FROM cached_articles WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			guard let id = string(at: 0, statement: statement),
				let feedKey = string(at: 1, statement: statement),
				let receivedAt = date(at: 2, statement: statement) else {
				throw OfflineLibraryError.invalidCacheState("A cached article had invalid metadata.")
			}
			articles.append(
				CachedArticleMetadata(
					id: id,
					feedKey: feedKey,
					receivedAt: receivedAt,
					isRead: sqlite3_column_int64(statement, 3) != 0,
					isStarred: sqlite3_column_int64(statement, 4) != 0,
				),
			)
		}

		var membershipsByArticleID: [String: Set<String>] = [:]
		try query(
			"SELECT article_id, collection_id FROM cached_collection_articles WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			guard let articleID = string(at: 0, statement: statement),
				let collectionID = string(at: 1, statement: statement) else {
				throw OfflineLibraryError.invalidCacheState("A cached membership had no identifier.")
			}
			membershipsByArticleID[articleID, default: []].insert(collectionID)
		}

		let subscriptions: [FeedSubscription]
		if let suppliedSubscriptions {
			subscriptions = suppliedSubscriptions
		} else {
			subscriptions = try cachedSubscriptions(accountID: accountID, database: database)
		}
		var collectionIDsByFeedKey: [String: Set<String>] = [:]
		for subscription in subscriptions {
			let ids = collectionIDs(for: [subscription])
			collectionIDsByFeedKey[subscription.feedKey, default: []].formUnion(ids)
			collectionIDsByFeedKey[subscription.id, default: []].formUnion(ids)
		}
		var navigationCollectionIDsByFeedKey: [String: Set<String>] = [:]
		try query(
			"SELECT id, feed_key FROM cached_navigation_items WHERE account_id = ? AND feed_key IS NOT NULL AND feed_key <> ''",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			guard let collectionID = string(at: 0, statement: statement),
				let feedKey = string(at: 1, statement: statement),
				feedKey.isEmpty == false else {
				return
			}
			navigationCollectionIDsByFeedKey[feedKey, default: []].insert(collectionID)
		}

		let protectedCollectionIDs = try cachedExplicitCollectionIDs(accountID: accountID, database: database)
		let bounds = dayBounds ?? ReaderLocalDayBounds.localDay(containing: .now)
		for article in articles {
			var expected = Set<String>()
			if article.isRead == false {
				expected.insert(ReaderSection.unread.rawValue)
			}
			if bounds.contains(article.receivedAt) {
				expected.insert(ReaderSection.today.rawValue)
			}
			if article.isStarred {
				expected.insert(ReaderSection.starred.rawValue)
			}
			let currentCollectionIDs = collectionIDsByFeedKey[article.feedKey, default: []]
			let navigationCollectionIDs = navigationCollectionIDsByFeedKey[article.feedKey, default: []]
			expected.formUnion(currentCollectionIDs.isEmpty ? navigationCollectionIDs : currentCollectionIDs)
			expected.subtract(protectedCollectionIDs)
			if expected.subtracting(membershipsByArticleID[article.id, default: []]).isEmpty == false {
				return false
			}
		}
		return true
	}

	private func rebuildAllMemberships(
		accountID: String,
		dayBounds: ReaderLocalDayBounds?,
		preservingLocalCollections: Bool = false,
		subscriptions suppliedSubscriptions: [FeedSubscription]? = nil,
		database: OpaquePointer,
	) throws {
		var articles: [Recommendation] = []
		try query(
			"SELECT payload FROM cached_articles WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			guard let payload = data(at: 0, statement: statement) else {
				throw OfflineLibraryError.invalidCacheState("A cached article had no payload.")
			}
			do {
				articles.append(try decoder.decode(Recommendation.self, from: payload))
			} catch {
				throw OfflineLibraryError.invalidCacheState("A cached article had an invalid payload.")
			}
		}
		let activeSubscriptions: [FeedSubscription]
		if let suppliedSubscriptions {
			activeSubscriptions = suppliedSubscriptions
		} else {
			activeSubscriptions = try cachedSubscriptions(accountID: accountID, database: database)
		}
		var subscriptionsByFeedKey: [String: [FeedSubscription]] = [:]
		for subscription in activeSubscriptions {
			subscriptionsByFeedKey[subscription.id, default: []].append(subscription)
			if subscription.feedKey != subscription.id {
				subscriptionsByFeedKey[subscription.feedKey, default: []].append(subscription)
			}
		}
		var navigationCollectionIDsByFeedKey: [String: Set<String>] = [:]
		try query(
			"SELECT id, feed_key FROM cached_navigation_items WHERE account_id = ? AND feed_key IS NOT NULL AND feed_key <> ''",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			guard let collectionID = string(at: 0, statement: statement),
				let feedKey = string(at: 1, statement: statement),
				feedKey.isEmpty == false else {
				return
			}
			navigationCollectionIDsByFeedKey[feedKey, default: []].insert(collectionID)
		}
		let protectedCollectionIDs = try cachedExplicitCollectionIDs(accountID: accountID, database: database)
		var localMemberships: [(collectionID: String, articleID: String, position: Int)] = []
		if preservingLocalCollections || protectedCollectionIDs.isEmpty == false {
			let managedCollectionIDs = Set([
				ReaderSection.unread.rawValue,
				ReaderSection.today.rawValue,
				ReaderSection.starred.rawValue,
			])
			let feedCollectionIDs = collectionIDs(for: activeSubscriptions)
			var navigationCollectionIDs = Set<String>()
			try query(
				"SELECT id FROM cached_navigation_items WHERE account_id = ?",
				bindings: [.text(accountID)],
				database: database,
			) { statement in
				if let collectionID = string(at: 0, statement: statement) {
					// ForYou is a local recommendation page even though it appears as a
					// navigation item; keep its ordered rows across a projection repair.
					if collectionID != ReaderSection.forYou.rawValue {
						navigationCollectionIDs.insert(collectionID)
					}
				}
			}
			let derivedCollectionIDs = managedCollectionIDs
				.union(feedCollectionIDs)
				.union(navigationCollectionIDs)
			let validArticleIDs = Set(articles.map(\.id))
			try query(
				"SELECT collection_id, article_id, position FROM cached_collection_articles WHERE account_id = ?",
				bindings: [.text(accountID)],
				database: database,
			) { statement in
				guard let collectionID = string(at: 0, statement: statement),
					let articleID = string(at: 1, statement: statement),
					(derivedCollectionIDs.contains(collectionID) == false || protectedCollectionIDs.contains(collectionID)),
					validArticleIDs.contains(articleID) else {
					return
				}
				localMemberships.append((collectionID, articleID, Int(sqlite3_column_int64(statement, 2))))
			}
		}
		// Decode the complete article set before deleting any projection rows. A
		// malformed article must leave the last valid membership projection intact so a
		// cold load can still show its valid stories and mark repair for the bad row.
		try execute(
			"DELETE FROM cached_collection_articles WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		)
		for article in articles {
			try rebuildMemberships(
				for: article,
				currentSubscriptions: subscriptionsByFeedKey[article.feedKey, default: []],
				navigationCollectionIDs: navigationCollectionIDsByFeedKey[article.feedKey, default: []],
				dayBounds: dayBounds,
				protectedCollectionIDs: protectedCollectionIDs,
				accountID: accountID,
				database: database,
			)
		}
		for membership in localMemberships {
			try insertCollectionMembership(
				accountID: accountID,
				collectionID: membership.collectionID,
				articleID: membership.articleID,
				position: membership.position,
				database: database,
			)
		}
	}

	private func insertCollectionMembership(
		accountID: String,
		collectionID: String,
		articleID: String,
		position: Int,
		database: OpaquePointer,
	) throws {
		try execute(
			"""
			INSERT INTO cached_collection_articles (account_id, collection_id, article_id, position)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(account_id, collection_id, article_id) DO UPDATE SET position = excluded.position
			""",
			bindings: [.text(accountID), .text(collectionID), .text(articleID), .int64(Int64(position))],
			database: database,
		)
	}

	private func makeNavigationFromCachedFeeds(accountID: String, database: OpaquePointer) throws -> ReaderNavigationState? {
		var subscriptions: [ReaderSubscription] = []
		try query(
			"""
			SELECT stream_id, title, feed_key, icon_url, folders_json
			FROM cached_feeds WHERE account_id = ? AND is_active = 1 ORDER BY title COLLATE NOCASE
			""",
			bindings: [.text(accountID)], database: database,
		) { statement in
			guard let streamID = string(at: 0, statement: statement),
				let title = string(at: 1, statement: statement),
				let feedKey = string(at: 2, statement: statement) else { return }
			let folders = data(at: 4, statement: statement).flatMap { try? decoder.decode([String].self, from: $0) } ?? []
			subscriptions.append(
				ReaderSubscription(
					id: streamID,
					title: title,
					categories: folders.map { ReaderSubscriptionCategory(id: "user/-/label/\($0)", label: $0) },
					url: "https://offline.invalid/feed/\(feedKey)",
					iconURL: string(at: 3, statement: statement),
				),
			)
		}
		guard subscriptions.isEmpty == false else { return nil }
		var countsByFeedKey: [String: Int] = [:]
		try query(
			"SELECT feed_key, COUNT(*) FROM cached_articles WHERE account_id = ? AND is_read = 0 GROUP BY feed_key",
			bindings: [.text(accountID)], database: database,
		) { statement in
			if let feedKey = string(at: 0, statement: statement) {
				countsByFeedKey[feedKey] = Int(sqlite3_column_int64(statement, 1))
			}
		}
		let unreadCounts = subscriptions.map { subscription in
			let feedKey = subscription.url.flatMap(URL.init(string:))?.lastPathComponent ?? ""
			return ReaderUnreadCount(id: subscription.id, count: countsByFeedKey[feedKey, default: 0])
		}
		let allArticles = try scalarCount("SELECT COUNT(*) FROM cached_articles WHERE account_id = ? AND is_read = 0", accountID: accountID, database: database)
		let today = try membershipUnreadCount(collectionID: ReaderSection.today.rawValue, accountID: accountID, database: database)
		let starred = try membershipUnreadCount(collectionID: ReaderSection.starred.rawValue, accountID: accountID, database: database)
		let forYou = try membershipUnreadCount(collectionID: ReaderSection.forYou.rawValue, accountID: accountID, database: database)
		let navigation = ReaderNavigationCatalog.make(
			subscriptions: subscriptions,
			unreadCounts: unreadCounts + [ReaderUnreadCount(id: "user/-/state/com.google/reading-list", count: allArticles)],
			smartCounts: ReaderNavigationSmartCounts(forYou: forYou, today: today, unread: allArticles, starred: starred),
		)
		try writeNavigation(navigation, accountID: accountID, database: database)
		return navigation
	}

	private func writeNavigation(
		_ navigation: ReaderNavigationState,
		payload: Data? = nil,
		accountID: String,
		database: OpaquePointer,
	) throws {
		let encodedPayload: Data
		if let payload {
			encodedPayload = payload
		} else {
			encodedPayload = try encoder.encode(navigation)
		}
		try execute(
			"""
			INSERT INTO cached_navigation (account_id, payload, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(account_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
			""",
			bindings: [
				.text(accountID), .blob(encodedPayload),
				.double(Date.now.timeIntervalSince1970),
			],
			database: database,
		)
		try cacheNavigationItems(navigation, accountID: accountID, database: database)
	}

	private func cacheNavigationItems(_ navigation: ReaderNavigationState, accountID: String, database: OpaquePointer) throws {
		try execute("DELETE FROM cached_navigation_items WHERE account_id = ?", bindings: [.text(accountID)], database: database)
		for item in navigation.items {
			try execute(
				"INSERT INTO cached_navigation_items (account_id, id, feed_key) VALUES (?, ?, ?)",
				bindings: [.text(accountID), .text(item.id), .optionalText(item.feedKey)], database: database,
			)
		}
	}

	private func clearCachedNavigation(accountID: String, database: OpaquePointer) throws {
		try execute(
			"DELETE FROM cached_navigation_items WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		)
		try execute(
			"DELETE FROM cached_navigation WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		)
	}

	private func deleteStagingRows(accountID: String, database: OpaquePointer) throws {
		for table in Self.rebuildCacheTables {
			try execute(
				"DELETE FROM \(table) WHERE account_id = ?",
				bindings: [.text(accountID)],
				database: database,
			)
		}
		try execute(
			"DELETE FROM cache_rebuild_intents WHERE staging_account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		)
	}

	private func seedRebuildIntents(
		accountID: String,
		stagingAccountID: String,
		database: OpaquePointer,
	) throws {
		var pending: [(Int64, String, Data, Double)] = []
		try query(
			"SELECT sequence, id, payload, created_at FROM pending_actions WHERE account_id = ? ORDER BY sequence",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			guard let mutationID = string(at: 1, statement: statement),
				let payload = data(at: 2, statement: statement),
				let mutation = try? decoder.decode(OfflineMutation.self, from: payload),
				mutation.isStatusProjection else {
				return
			}
			pending.append((
				sqlite3_column_int64(statement, 0),
				mutationID,
				payload,
				sqlite3_column_double(statement, 3),
			))
		}
		for (sequence, mutationID, payload, createdAt) in pending {
			try execute(
				"INSERT OR IGNORE INTO cache_rebuild_intents (account_id, staging_account_id, mutation_id, sequence, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				bindings: [
					.text(accountID), .text(stagingAccountID), .text(mutationID), .int64(sequence),
					.blob(payload), .double(createdAt),
				],
				database: database,
			)
		}
	}

	private func applyPendingStatusOverlay(
		accountID: String,
		storageAccountID: String,
		database: OpaquePointer,
	) throws {
		guard let stagingAccountID = stagingAccountIDs[accountID], stagingAccountID == storageAccountID else {
			return
		}
		var mutations: [OfflineMutation] = []
		try query(
			"SELECT payload FROM cache_rebuild_intents WHERE account_id = ? AND staging_account_id = ? ORDER BY sequence",
			bindings: [.text(accountID), .text(stagingAccountID)],
			database: database,
		) { statement in
			guard let payload = data(at: 0, statement: statement),
				let mutation = try? decoder.decode(OfflineMutation.self, from: payload) else {
				throw OfflineLibraryError.invalidCacheState("A rebuild status intent had an invalid payload.")
			}
			mutations.append(mutation)
		}
		for mutation in mutations {
			try applyStatusProjection(mutation, storageAccountID: storageAccountID, database: database)
		}
	}

	private func applyStatusProjection(
		_ mutation: OfflineMutation,
		storageAccountID: String,
		database: OpaquePointer,
	) throws {
		guard mutation.isStatusProjection, let value = mutation.value else { return }
		var updatedArticleIDs: Set<String> = []
		for itemID in mutation.itemIds {
			for lookupID in statusLookupIdentifiers(itemID) {
				for storedArticle in try loadStoredArticles(
					identifier: lookupID,
					accountID: storageAccountID,
					database: database,
				) where updatedArticleIDs.insert(storedArticle.id).inserted {
					var article = storedArticle.article
					switch mutation.kind {
					case .setRead, .setReadBatch:
						article.isRead = value
					case .setStarred:
						article.isStarred = value
					default:
						continue
					}
					try writeArticle(
						article,
						bodyPruned: storedArticle.bodyPruned,
						accountID: storageAccountID,
						database: database,
					)
				}
			}
		}
	}

	private func statusLookupIdentifiers(_ itemID: String) -> [String] {
		let prefix = "tag:google.com,2005:reader/item/"
		if itemID.hasPrefix(prefix),
			let rowID = UInt64(String(itemID.dropFirst(prefix.count)), radix: 16) {
			return [itemID, String(rowID)]
		}
		if let rowID = UInt64(itemID) {
			return [itemID, prefix + String(rowID, radix: 16)]
		}
		return [itemID]
	}

	private func preserveCanonicalForYouMemberships(
		accountID: String,
		stagingAccountID: String,
		database: OpaquePointer,
	) throws {
		try execute(
			"""
			INSERT INTO cached_collection_articles (account_id, collection_id, article_id, position)
			SELECT ?, ?, staged.id, canonical_membership.position
			FROM cached_collection_articles AS canonical_membership
			JOIN cached_articles AS canonical_article
			  ON canonical_article.account_id = canonical_membership.account_id
			 AND canonical_article.id = canonical_membership.article_id
			JOIN cached_articles AS staged
			  ON staged.account_id = ?
			 AND (
				 staged.id = canonical_article.id
				 OR (
					 canonical_article.reader_id <> ''
					 AND staged.reader_id <> ''
					 AND staged.reader_id = canonical_article.reader_id
				 )
			 )
			WHERE canonical_membership.account_id = ?
			  AND canonical_membership.collection_id = ?
			ON CONFLICT(account_id, collection_id, article_id) DO UPDATE SET
			position = CASE WHEN cached_collection_articles.position < excluded.position
				THEN cached_collection_articles.position ELSE excluded.position END
			""",
			bindings: [
				.text(stagingAccountID), .text(ReaderSection.forYou.rawValue), .text(stagingAccountID),
				.text(accountID), .text(ReaderSection.forYou.rawValue),
			],
			database: database,
		)
	}

	private func preserveCanonicalArticleBodies(
		accountID: String,
		stagingAccountID: String,
		database: OpaquePointer,
	) throws {
		var replacements: [String: Recommendation] = [:]
		try query(
			"""
			SELECT staged.id, staged.payload, canonical.payload
			FROM cached_articles AS staged
			JOIN cached_articles AS canonical
			  ON canonical.account_id = ?
			 AND (
				 canonical.id = staged.id
				 OR (
					 canonical.reader_id <> ''
					 AND staged.reader_id <> ''
					 AND canonical.reader_id = staged.reader_id
				 )
				 )
			JOIN cached_collection_articles AS canonical_recommendation
			  ON canonical_recommendation.account_id = ?
			 AND canonical_recommendation.collection_id = ?
			 AND canonical_recommendation.article_id = canonical.id
			WHERE staged.account_id = ? AND staged.body_pruned = 1
			""",
			bindings: [
				.text(accountID), .text(accountID), .text(ReaderSection.forYou.rawValue),
				.text(stagingAccountID),
			],
			database: database,
		) { statement in
			guard let stageID = string(at: 0, statement: statement),
				let stagePayload = data(at: 1, statement: statement),
				let canonicalPayload = data(at: 2, statement: statement),
				let stagedArticle = try? decoder.decode(Recommendation.self, from: stagePayload),
				let canonicalArticle = try? decoder.decode(Recommendation.self, from: canonicalPayload),
				stagedArticle.hasReadableHTML == false,
				canonicalArticle.hasReadableHTML else {
				return
			}
			replacements[stageID] = articleWithID(stagedArticle.replacingHTML(canonicalArticle.html), id: stageID)
		}
		for article in replacements.values {
			try writeArticle(article, bodyPruned: false, accountID: stagingAccountID, database: database)
		}
	}

	private func preserveCanonicalPagination(
		accountID: String,
		stagingAccountID: String,
		database: OpaquePointer,
	) throws {
		try execute(
			"""
			INSERT INTO cached_collection_pagination (account_id, collection_id, continuation)
			SELECT ?, collection_id, continuation
			FROM cached_collection_pagination
			WHERE account_id = ? AND continuation <> ''
			ON CONFLICT(account_id, collection_id) DO NOTHING
			""",
			bindings: [.text(stagingAccountID), .text(accountID)],
			database: database,
		)
		// Discard canonical continuation tokens for feeds/folders absent from the
		// staged authoritative navigation. Smart ForYou/Today/Unread pages are retained
		// because they are local collection views and have no feed item in navigation.
		try execute(
			"""
			DELETE FROM cached_collection_pagination
			WHERE account_id = ?
			  AND (
				  continuation = ''
				  OR (
					  collection_id <> ?
					  AND NOT EXISTS (
					  SELECT 1 FROM cached_navigation_items staged_navigation
					  WHERE staged_navigation.account_id = ?
						AND staged_navigation.id = cached_collection_pagination.collection_id
					  )
				  )
				  )
			""",
			bindings: [.text(stagingAccountID), .text(ReaderSection.forYou.rawValue), .text(stagingAccountID)],
			database: database,
		)
	}

	private func promoteStaging(
		accountID: String,
		stagingAccountID: String,
		date _: Date,
		database: OpaquePointer,
	) throws {
		guard accountID != stagingAccountID else {
			throw OfflineLibraryError.invalidCacheState("The rebuild generation was not isolated from the account cache.")
		}
		// Recommendations and selected collection pages are local read state rather
		// than sync-owned tables. Carry only rows whose article still exists in the
		// authoritative staged generation; a deleted server article is therefore not
		// resurrected by this merge.
		try preserveCanonicalForYouMemberships(
			accountID: accountID,
			stagingAccountID: stagingAccountID,
			database: database,
		)
		try preserveCanonicalArticleBodies(
			accountID: accountID,
			stagingAccountID: stagingAccountID,
			database: database,
		)
		try preserveCanonicalPagination(
			accountID: accountID,
			stagingAccountID: stagingAccountID,
			database: database,
		)
		let copies = [
			("cached_navigation_items", "id, feed_key"),
			("cached_navigation", "payload, updated_at"),
			("cached_subscriptions", "id, title, payload"),
			("cached_feeds", "feed_key, stream_id, title, feed_url, site_url, icon_url, is_active, folders_json"),
			("cached_articles", "id, reader_id, feed_key, received_at, is_read, is_starred, body_pruned, payload"),
			("cached_collection_articles", "collection_id, article_id, position"),
			("cached_collection_pagination", "collection_id, continuation"),
			("sync_state", "cursor, last_sync_at"),
			("cache_integrity", "format_version, state, navigation_freshness, last_attempt_at, last_success_at, last_error, invalid_change_count, last_page_has_more, updated_at"),
		]
		for (table, columns) in copies {
			try execute(
				"DELETE FROM \(table) WHERE account_id = ?",
				bindings: [.text(accountID)],
				database: database,
			)
			try execute(
				"INSERT INTO \(table) (account_id, \(columns)) SELECT ?, \(columns) FROM \(table) WHERE account_id = ?",
				bindings: [.text(accountID), .text(stagingAccountID)],
				database: database,
			)
		}
		// A completed authoritative rebuild owns sync-derived collections. Keep the
		// local ForYou page marker, but discard markers for feed/smart pages so later
		// repair can reconcile the promoted projection with server state.
		try execute(
			"DELETE FROM cached_collection_states WHERE account_id = ? AND collection_id <> ?",
			bindings: [.text(accountID), .text(ReaderSection.forYou.rawValue)],
			database: database,
		)
		try execute(
			"DELETE FROM cache_rebuilds WHERE account_id = ? AND staging_account_id = ?",
			bindings: [.text(accountID), .text(stagingAccountID)],
			database: database,
		)
		try deleteStagingRows(accountID: stagingAccountID, database: database)
	}

	private func membershipUnreadCount(collectionID: String, accountID: String, database: OpaquePointer) throws -> Int {
		try queryOne(
			"""
			SELECT COUNT(*) FROM cached_collection_articles ca
			JOIN cached_articles a ON a.account_id = ca.account_id AND a.id = ca.article_id
			WHERE ca.account_id = ? AND ca.collection_id = ? AND a.is_read = 0
			""",
			bindings: [.text(accountID), .text(collectionID)], database: database,
			map: { Int(sqlite3_column_int64($0, 0)) },
		) ?? 0
	}

	private func scalarCount(_ sql: String, accountID: String, database: OpaquePointer) throws -> Int {
		try queryOne(sql, bindings: [.text(accountID)], database: database) { Int(sqlite3_column_int64($0, 0)) } ?? 0
	}

	private func loadCacheIntegrity(accountID: String, database: OpaquePointer) throws -> OfflineCacheIntegrity {
		let row = try queryOne(
			"""
			SELECT format_version, state, navigation_freshness, last_attempt_at,
			       last_success_at, last_error, invalid_change_count, last_page_has_more
			FROM cache_integrity WHERE account_id = ?
			""",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			(
				Int(sqlite3_column_int64(statement, 0)),
				string(at: 1, statement: statement),
				string(at: 2, statement: statement),
				date(at: 3, statement: statement),
				date(at: 4, statement: statement),
				string(at: 5, statement: statement),
				Int(sqlite3_column_int64(statement, 6)),
				sqlite3_column_type(statement, 7) == SQLITE_NULL
					? nil
					: sqlite3_column_int64(statement, 7) != 0,
			)
		}
		guard let row,
			let state = row.1.flatMap(OfflineCacheState.init(rawValue:)),
			let navigation = row.2.flatMap(OfflineNavigationFreshness.init(rawValue:)) else {
			return .needsBootstrap
		}
		return OfflineCacheIntegrity(
			formatVersion: row.0,
			state: state,
			navigation: navigation,
			lastAttemptAt: row.3,
			lastSuccessAt: row.4,
			lastError: row.5,
			invalidChangeCount: row.6,
			lastPageHasMore: row.7,
		)
	}

	private func saveCacheIntegrity(
		_ integrity: OfflineCacheIntegrity,
		accountID: String,
		database: OpaquePointer,
	) throws {
		try execute(
			"""
			INSERT INTO cache_integrity
			(account_id, format_version, state, navigation_freshness, last_attempt_at,
			 last_success_at, last_error, invalid_change_count, last_page_has_more, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(account_id) DO UPDATE SET
			format_version = excluded.format_version,
			state = excluded.state,
			navigation_freshness = excluded.navigation_freshness,
			last_attempt_at = excluded.last_attempt_at,
			last_success_at = excluded.last_success_at,
			last_error = excluded.last_error,
			invalid_change_count = excluded.invalid_change_count,
			last_page_has_more = excluded.last_page_has_more,
			updated_at = excluded.updated_at
			""",
			bindings: [
				.text(accountID), .int64(Int64(integrity.formatVersion)), .text(integrity.state.rawValue),
				.text(integrity.navigation.rawValue), .optionalDouble(integrity.lastAttemptAt?.timeIntervalSince1970),
				.optionalDouble(integrity.lastSuccessAt?.timeIntervalSince1970), .optionalText(integrity.lastError),
				.int64(Int64(integrity.invalidChangeCount)), .optionalInt64(integrity.lastPageHasMore.map { $0 ? 1 : 0 }),
				.double(Date.now.timeIntervalSince1970),
			],
			database: database,
		)
	}

	private func openDatabase() throws -> OpaquePointer {
		if let database { return database }
		if let databaseURL {
			try FileManager.default.createDirectory(
				at: databaseURL.deletingLastPathComponent(),
				withIntermediateDirectories: true,
			)
		}
		var opened: OpaquePointer?
		let path = databaseURL?.path(percentEncoded: false) ?? ":memory:"
		guard sqlite3_open_v2(path, &opened, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
			let opened else {
			throw OfflineLibraryError.openFailed
		}
		database = opened
		try execute("PRAGMA journal_mode = WAL", database: opened)
		try execute("PRAGMA foreign_keys = ON", database: opened)
		try execute("PRAGMA busy_timeout = 5000", database: opened)
		try createSchema(database: opened)
		if let previewSeed {
			try saveArticles(previewSeed.articles, collectionID: previewSeed.collectionID, accountID: previewSeed.accountID)
			self.previewSeed = nil
		}
		return opened
	}

	private func createSchema(database: OpaquePointer) throws {
		let statements = [
			"CREATE TABLE IF NOT EXISTS cached_navigation (account_id TEXT PRIMARY KEY, payload BLOB NOT NULL, updated_at REAL NOT NULL)",
			"CREATE TABLE IF NOT EXISTS cached_navigation_items (account_id TEXT NOT NULL, id TEXT NOT NULL, feed_key TEXT, PRIMARY KEY (account_id, id))",
			"CREATE INDEX IF NOT EXISTS idx_cached_navigation_items_feed ON cached_navigation_items(account_id, feed_key)",
			"CREATE TABLE IF NOT EXISTS cached_subscriptions (account_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY (account_id, id))",
			"CREATE TABLE IF NOT EXISTS cached_feeds (account_id TEXT NOT NULL, feed_key TEXT NOT NULL, stream_id TEXT NOT NULL, title TEXT NOT NULL, feed_url TEXT, site_url TEXT, icon_url TEXT, is_active INTEGER NOT NULL DEFAULT 1, folders_json BLOB NOT NULL, PRIMARY KEY (account_id, feed_key))",
			"CREATE TABLE IF NOT EXISTS cached_articles (account_id TEXT NOT NULL, id TEXT NOT NULL, reader_id TEXT NOT NULL, feed_key TEXT NOT NULL, received_at REAL NOT NULL, is_read INTEGER NOT NULL, is_starred INTEGER NOT NULL, body_pruned INTEGER NOT NULL DEFAULT 0, payload BLOB NOT NULL, PRIMARY KEY (account_id, id))",
			"CREATE INDEX IF NOT EXISTS idx_cached_articles_account_date ON cached_articles(account_id, received_at DESC)",
			"CREATE INDEX IF NOT EXISTS idx_cached_articles_feed ON cached_articles(account_id, feed_key, received_at DESC)",
			"CREATE TABLE IF NOT EXISTS cached_collection_articles (account_id TEXT NOT NULL, collection_id TEXT NOT NULL, article_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (account_id, collection_id, article_id))",
			"CREATE INDEX IF NOT EXISTS idx_cached_collection_order ON cached_collection_articles(account_id, collection_id, position)",
			"CREATE TABLE IF NOT EXISTS cached_collection_pagination (account_id TEXT NOT NULL, collection_id TEXT NOT NULL, continuation TEXT NOT NULL, PRIMARY KEY (account_id, collection_id))",
			"CREATE TABLE IF NOT EXISTS cached_collection_states (account_id TEXT NOT NULL, collection_id TEXT NOT NULL, explicit_page INTEGER NOT NULL DEFAULT 1, updated_at REAL NOT NULL, PRIMARY KEY (account_id, collection_id))",
			"CREATE INDEX IF NOT EXISTS idx_cached_collection_states_account ON cached_collection_states(account_id, explicit_page)",
			"CREATE TABLE IF NOT EXISTS cache_collection_state_migrations (account_id TEXT PRIMARY KEY, seeded_at REAL NOT NULL)",
			"CREATE TABLE IF NOT EXISTS sync_state (account_id TEXT PRIMARY KEY, cursor TEXT, last_sync_at REAL)",
			"CREATE TABLE IF NOT EXISTS cache_integrity (account_id TEXT PRIMARY KEY, format_version INTEGER NOT NULL, state TEXT NOT NULL, navigation_freshness TEXT NOT NULL, last_attempt_at REAL, last_success_at REAL, last_error TEXT, invalid_change_count INTEGER NOT NULL DEFAULT 0, last_page_has_more INTEGER, updated_at REAL NOT NULL)",
			"CREATE TABLE IF NOT EXISTS cache_rebuilds (account_id TEXT PRIMARY KEY, staging_account_id TEXT NOT NULL UNIQUE, created_at REAL NOT NULL)",
			"CREATE TABLE IF NOT EXISTS cache_rebuild_intents (account_id TEXT NOT NULL, staging_account_id TEXT NOT NULL, mutation_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload BLOB NOT NULL, created_at REAL NOT NULL, PRIMARY KEY (account_id, mutation_id))",
			"CREATE INDEX IF NOT EXISTS idx_cache_rebuild_intents_stage ON cache_rebuild_intents(staging_account_id)",
			"CREATE TABLE IF NOT EXISTS pending_actions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at REAL NOT NULL, UNIQUE (account_id, id))",
			"CREATE INDEX IF NOT EXISTS idx_pending_actions_account ON pending_actions(account_id, sequence)",
			"CREATE TABLE IF NOT EXISTS reader_state (account_id TEXT PRIMARY KEY, payload BLOB NOT NULL, updated_at REAL NOT NULL)",
		]
		for sql in statements { try execute(sql, database: database) }
		try migrateCacheRebuildIntents(database: database)
		try migrateCollectionStateMarkers(database: database)
		try execute(
			"CREATE INDEX IF NOT EXISTS idx_cache_rebuild_intents_stage_sequence ON cache_rebuild_intents(staging_account_id, sequence)",
			database: database,
		)
	}

	private func migrateCollectionStateMarkers(database: OpaquePointer) throws {
		let schemaMarker = "__schema_v1__"
		guard try scalarCount(
			"SELECT COUNT(*) FROM cache_collection_state_migrations WHERE account_id = ?",
			accountID: schemaMarker,
			database: database,
		) == 0 else {
			return
		}
		var accounts = Set<String>()
		try query(
			"""
			SELECT account_id FROM cached_collection_articles
			UNION SELECT account_id FROM cached_navigation_items
			UNION SELECT account_id FROM cached_navigation
			UNION SELECT account_id FROM cached_collection_pagination
			""",
			database: database,
		) { statement in
			if let accountID = string(at: 0, statement: statement), accountID.hasPrefix("__pigeon_rebuild__") == false {
				accounts.insert(accountID)
			}
		}
		try transaction(database) {
			let now = Date.now.timeIntervalSince1970
			for accountID in accounts {
				// Older builds did not record whether a collection came from a direct
				// page replacement or from sync. Preserve every existing projection
				// conservatively, including empty smart/feed pages represented only by
				// navigation items, until a subsequent authoritative rebuild reconciles it.
				try execute(
					"""
					INSERT OR IGNORE INTO cached_collection_states
					(account_id, collection_id, explicit_page, updated_at)
					SELECT account_id, collection_id, 1, ?
					FROM cached_collection_articles WHERE account_id = ?
					""",
					bindings: [.double(now), .text(accountID)],
					database: database,
				)
				try execute(
					"""
					INSERT OR IGNORE INTO cached_collection_states
					(account_id, collection_id, explicit_page, updated_at)
					SELECT account_id, id, 1, ?
					FROM cached_navigation_items WHERE account_id = ?
					""",
					bindings: [.double(now), .text(accountID)],
					database: database,
				)
				// Some old databases retained the navigation blob but not its item
				// index. Decode it opportunistically; malformed navigation is handled by
				// the normal tolerant snapshot path and must not abort this migration.
				try query(
					"SELECT payload FROM cached_navigation WHERE account_id = ?",
					bindings: [.text(accountID)],
					database: database,
				) { statement in
					guard let payload = data(at: 0, statement: statement),
						let navigation = try? decoder.decode(ReaderNavigationState.self, from: payload) else {
						return
					}
					for item in navigation.items {
						try execute(
							"INSERT OR IGNORE INTO cached_collection_states (account_id, collection_id, explicit_page, updated_at) VALUES (?, ?, 1, ?)",
							bindings: [.text(accountID), .text(item.id), .double(now)],
							database: database,
						)
					}
				}
			}
			try execute(
				"INSERT INTO cache_collection_state_migrations (account_id, seeded_at) VALUES (?, ?)",
				bindings: [.text(schemaMarker), .double(now)],
				database: database,
			)
		}
	}

	private func migrateCacheRebuildIntents(database: OpaquePointer) throws {
		var columns = Set<String>()
		try query("PRAGMA table_info(cache_rebuild_intents)", database: database) { statement in
			if let name = string(at: 1, statement: statement) {
				columns.insert(name)
			}
		}
		guard columns.contains("sequence") == false else { return }
		// This table is private rebuild state. Older development databases may have
		// created it before the durable pending-action sequence was added. Preserve
		// those rows and recover their original order from pending_actions where the
		// mutation is still queued; rowid is a stable best-effort order for an already
		// acknowledged intent that is intentionally retained through promotion.
		try execute(
			"ALTER TABLE cache_rebuild_intents ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0",
			database: database,
		)
		try execute(
			"""
			UPDATE cache_rebuild_intents
			SET sequence = COALESCE(
				(SELECT pending_actions.sequence
				 FROM pending_actions
				 WHERE pending_actions.account_id = cache_rebuild_intents.account_id
				   AND pending_actions.id = cache_rebuild_intents.mutation_id),
				rowid
			)
			WHERE sequence = 0
			""",
			database: database,
		)
	}

	private static func defaultDatabaseURL() -> URL {
		let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
			?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
		return root.appending(path: "PigeonReader", directoryHint: .isDirectory).appending(path: "OfflineLibrary.sqlite")
	}

	private func transaction(_ database: OpaquePointer, body: () throws -> Void) throws {
		try execute("BEGIN IMMEDIATE", database: database)
		do {
			try body()
			try execute("COMMIT", database: database)
		} catch {
			try? execute("ROLLBACK", database: database)
			throw error
		}
	}

	private func loadSinglePayload<T: Decodable & Sendable>(
		_ type: T.Type,
		sql: String,
		bindings: [SQLiteBinding],
		database: OpaquePointer,
	) throws -> T? {
		guard let payload = try queryOne(sql, bindings: bindings, database: database, map: { data(at: 0, statement: $0) }) ?? nil else { return nil }
		return try decoder.decode(type, from: payload)
	}

	private func loadPayloads<T: Decodable & Sendable>(
		_ type: T.Type,
		sql: String,
		bindings: [SQLiteBinding],
		database: OpaquePointer,
	) throws -> [T] {
		var values: [T] = []
		try query(sql, bindings: bindings, database: database) { statement in
			if let payload = data(at: 0, statement: statement), let value = try? decoder.decode(type, from: payload) {
				values.append(value)
			}
		}
		return values
	}

	private func execute(_ sql: String, bindings: [SQLiteBinding] = [], database: OpaquePointer) throws {
		var statement: OpaquePointer?
		guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
			throw databaseError(database)
		}
		defer { sqlite3_finalize(statement) }
		try bind(bindings, to: statement, database: database)
		while true {
			switch sqlite3_step(statement) {
			case SQLITE_ROW:
				// PRAGMA journal_mode returns a row before it completes.
				continue
			case SQLITE_DONE:
				return
			default:
				throw databaseError(database)
			}
		}
	}

	private func query(
		_ sql: String,
		bindings: [SQLiteBinding] = [],
		database: OpaquePointer,
		row: (OpaquePointer) throws -> Void,
	) throws {
		var statement: OpaquePointer?
		guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
			throw databaseError(database)
		}
		defer { sqlite3_finalize(statement) }
		try bind(bindings, to: statement, database: database)
		while true {
			switch sqlite3_step(statement) {
			case SQLITE_ROW: try row(statement)
			case SQLITE_DONE: return
			default: throw databaseError(database)
			}
		}
	}

	private func queryOne<T>(
		_ sql: String,
		bindings: [SQLiteBinding] = [],
		database: OpaquePointer,
		map: (OpaquePointer) throws -> T,
	) throws -> T? {
		var result: T?
		try query(sql, bindings: bindings, database: database) { statement in
			if result == nil { result = try map(statement) }
		}
		return result
	}

	private func bind(_ bindings: [SQLiteBinding], to statement: OpaquePointer, database: OpaquePointer) throws {
		for (offset, binding) in bindings.enumerated() {
			let index = Int32(offset + 1)
			let result: Int32
			switch binding {
			case .null: result = sqlite3_bind_null(statement, index)
			case .text(let value): result = sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
			case .int64(let value): result = sqlite3_bind_int64(statement, index, value)
			case .double(let value): result = sqlite3_bind_double(statement, index, value)
			case .blob(let value):
				result = value.withUnsafeBytes { bytes in
					sqlite3_bind_blob(statement, index, bytes.baseAddress, Int32(bytes.count), sqliteTransient)
				}
			}
			guard result == SQLITE_OK else { throw databaseError(database) }
		}
	}

	private func string(at index: Int32, statement: OpaquePointer) -> String? {
		guard sqlite3_column_type(statement, index) != SQLITE_NULL,
			let value = sqlite3_column_text(statement, index) else { return nil }
		return String(cString: value)
	}

	private func data(at index: Int32, statement: OpaquePointer) -> Data? {
		guard sqlite3_column_type(statement, index) != SQLITE_NULL,
			let bytes = sqlite3_column_blob(statement, index) else { return nil }
		return Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, index)))
	}

	private func date(at index: Int32, statement: OpaquePointer) -> Date? {
		guard sqlite3_column_type(statement, index) != SQLITE_NULL else { return nil }
		return Date(timeIntervalSince1970: sqlite3_column_double(statement, index))
	}

	private func databaseError(_ database: OpaquePointer) -> OfflineLibraryError {
		OfflineLibraryError.sqlite(String(cString: sqlite3_errmsg(database)))
	}
}

private nonisolated enum SQLiteBinding {
	case null
	case text(String)
	case int64(Int64)
	case double(Double)
	case blob(Data)

	static func optionalText(_ value: String?) -> SQLiteBinding {
		value.map(SQLiteBinding.text) ?? .null
	}

	static func optionalDouble(_ value: Double?) -> SQLiteBinding {
		value.map(SQLiteBinding.double) ?? .null
	}

	static func optionalInt64(_ value: Int64?) -> SQLiteBinding {
		value.map(SQLiteBinding.int64) ?? .null
	}
}

nonisolated(unsafe) private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

nonisolated enum OfflineLibraryError: LocalizedError, Equatable {
	case openFailed
	case sqlite(String)
	case invalidSyncChange(String)
	case missingStatusTarget(String)
	case invalidCacheState(String)
	case navigationUnavailable

	var errorDescription: String? {
		switch self {
		case .openFailed: "Pigeon could not open its offline library."
		case .sqlite(let message): "Pigeon could not update its offline library: \(message)"
		case .invalidSyncChange(let message): "Pigeon received an invalid sync change: \(message)"
		case .missingStatusTarget(let articleID): "Pigeon could not apply a status for missing article \(articleID)."
		case .invalidCacheState(let message): "Pigeon could not complete offline synchronization: \(message)"
		case .navigationUnavailable: "Pigeon could not refresh its navigation counts."
		}
	}
}

private nonisolated extension OfflineMutation {
	var isStatusProjection: Bool {
		switch kind {
		case .setRead, .setReadBatch, .setStarred:
			return value != nil && itemIds.isEmpty == false
		default:
			return false
		}
	}
}
