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
		let database = try openDatabase()
		try reconcileArticleIdentities(accountID: accountID, database: database)
		let navigation = try loadSinglePayload(
			ReaderNavigationState.self,
			sql: "SELECT payload FROM cached_navigation WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		)
		let subscriptions = try loadPayloads(
			FeedSubscription.self,
			sql: "SELECT payload FROM cached_subscriptions WHERE account_id = ? ORDER BY title COLLATE NOCASE, id",
			bindings: [.text(accountID)],
			database: database,
		)
		let restoration = try loadSinglePayload(
			ReaderRestorationState.self,
			sql: "SELECT payload FROM reader_state WHERE account_id = ?",
			bindings: [.text(accountID)],
			database: database,
		)
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

		var articlesByCollection: [String: [Recommendation]] = [:]
		// A cached article can belong to many collections; decode its payload once,
		// then reuse the value while preserving the membership query's order.
		var decodedArticlesByID: [String: Recommendation] = [:]
		try query(
			"""
			SELECT ca.collection_id, ca.article_id, a.body_pruned, a.payload
			FROM cached_collection_articles ca
			JOIN cached_articles a
			  ON a.account_id = ca.account_id AND a.id = ca.article_id
			WHERE ca.account_id = ?
			ORDER BY ca.collection_id, ca.position, a.received_at DESC, a.id
			""",
			bindings: [.text(accountID)],
			database: database,
		) { statement in
			guard let collectionID = string(at: 0, statement: statement),
				let articleID = string(at: 1, statement: statement),
				let payload = data(at: 3, statement: statement) else {
				return
			}
			let article: Recommendation
			if let cachedArticle = decodedArticlesByID[articleID] {
				article = cachedArticle
			} else {
				guard let decodedArticle = try? decoder.decode(Recommendation.self, from: payload) else {
					return
				}
				let resolvedArticle = sqlite3_column_int64(statement, 2) != 0
					? decodedArticle.replacingHTML("")
					: decodedArticle
				decodedArticlesByID[articleID] = resolvedArticle
				article = resolvedArticle
				#if DEBUG
				snapshotArticleDecodeCount += 1
				#endif
			}
			articlesByCollection[collectionID, default: []].append(article)
		}

		let derivedNavigation: ReaderNavigationState?
		if let navigation {
			derivedNavigation = navigation
		} else {
			derivedNavigation = try makeNavigationFromCachedFeeds(accountID: accountID, database: database)
		}
		return CachedLibrarySnapshot(
			navigation: derivedNavigation,
			subscriptions: subscriptions,
			articlesByCollection: articlesByCollection,
			continuationsByCollection: continuationsByCollection,
			restoration: restoration,
			cursor: syncState?.0,
			lastSyncAt: syncState?.1,
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
		let payload = try encoder.encode(navigation)
		try transaction(database) {
			try execute(
				"""
				INSERT INTO cached_navigation (account_id, payload, updated_at) VALUES (?, ?, ?)
				ON CONFLICT(account_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
				""",
				bindings: [.text(accountID), .blob(payload), .double(Date.now.timeIntervalSince1970)],
				database: database,
			)
			try cacheNavigationItems(navigation, accountID: accountID, database: database)
		}
	}

	func saveSubscriptions(_ subscriptions: [FeedSubscription], accountID: String) throws {
		let database = try openDatabase()
		try transaction(database) {
			try execute("DELETE FROM cached_subscriptions WHERE account_id = ?", bindings: [.text(accountID)], database: database)
			for subscription in subscriptions {
				try execute(
					"INSERT INTO cached_subscriptions (account_id, id, title, payload) VALUES (?, ?, ?, ?)",
					bindings: [.text(accountID), .text(subscription.id), .text(subscription.title), .blob(try encoder.encode(subscription))],
					database: database,
				)
			}
		}
	}

	func saveArticles(_ articles: [Recommendation], collectionID: String, accountID: String) throws {
		let database = try openDatabase()
		try reconcileArticleIdentities(accountID: accountID, database: database)
		try transaction(database) {
			try execute(
				"DELETE FROM cached_collection_articles WHERE account_id = ? AND collection_id = ?",
				bindings: [.text(accountID), .text(collectionID)],
				database: database,
			)
			for (position, article) in articles.enumerated() {
				let storedArticle = try upsertArticle(sanitized(article), accountID: accountID, database: database)
				try insertCollectionMembership(
					accountID: accountID,
					collectionID: collectionID,
					articleID: storedArticle.id,
					position: position,
					database: database,
				)
			}
		}
	}

	func saveCollectionContinuation(_ continuation: String?, collectionID: String, accountID: String) throws {
		let database = try openDatabase()
		try transaction(database) {
			if let continuation, continuation.isEmpty == false {
				try execute(
					"""
					INSERT INTO cached_collection_pagination (account_id, collection_id, continuation)
					VALUES (?, ?, ?)
					ON CONFLICT(account_id, collection_id) DO UPDATE SET continuation = excluded.continuation
					""",
					bindings: [.text(accountID), .text(collectionID), .text(continuation)],
					database: database,
				)
			} else {
				try execute(
					"DELETE FROM cached_collection_pagination WHERE account_id = ? AND collection_id = ?",
					bindings: [.text(accountID), .text(collectionID)],
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
		try execute(
			"""
			INSERT OR IGNORE INTO pending_actions
			(account_id, id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)
			""",
			bindings: [
				.text(accountID), .text(mutation.id), .text(mutation.kind.rawValue),
				.blob(try encoder.encode(mutation)), .double(Date.now.timeIntervalSince1970),
			],
			database: database,
		)
	}

	func pendingMutations(accountID: String, limit: Int = 100) throws -> [PendingOfflineMutation] {
		let database = try openDatabase()
		var mutations: [PendingOfflineMutation] = []
		try query(
			"""
			SELECT sequence, payload, attempts, last_error, created_at
			FROM pending_actions WHERE account_id = ? ORDER BY sequence LIMIT ?
			""",
			bindings: [.text(accountID), .int64(Int64(max(1, min(limit, 100))))],
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

	func apply(_ page: IncrementalSyncPage, accountID: String) throws {
		let database = try openDatabase()
		try transaction(database) {
			try reconcileArticleIdentities(accountID: accountID, database: database)
			for change in page.changes {
				try apply(change, accountID: accountID, database: database)
			}
			if page.changes.isEmpty == false {
				// Counts and collection membership are derived from synced rows.
				// Force the next snapshot to rebuild them with this committed page.
				try execute(
					"DELETE FROM cached_navigation WHERE account_id = ?",
					bindings: [.text(accountID)],
					database: database,
				)
			}
			try execute(
				"""
				INSERT INTO sync_state (account_id, cursor, last_sync_at) VALUES (?, ?, ?)
				ON CONFLICT(account_id) DO UPDATE SET cursor = excluded.cursor, last_sync_at = excluded.last_sync_at
				""",
				bindings: [.text(accountID), .text(page.cursor), .double(Date.now.timeIntervalSince1970)],
				database: database,
			)
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
		return OfflineStorageStats(
			articleCount: article.0,
			bodyBytes: article.1,
			pendingMutationCount: pending,
			lastSyncAt: lastSync,
		)
	}

	func cleanupReadBodies(accountID: String, keepingNewest count: Int = 200) throws -> Int {
		let database = try openDatabase()
		try reconcileArticleIdentities(accountID: accountID, database: database)
		var candidates: [(String, Recommendation)] = []
		try query(
			"""
			SELECT id, payload FROM cached_articles
			WHERE account_id = ? AND is_read = 1 AND is_starred = 0
			ORDER BY received_at DESC LIMIT -1 OFFSET ?
			""",
			bindings: [.text(accountID), .int64(Int64(max(count, 0)))],
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
					bindings: [.blob(try encoder.encode(pruned)), .text(accountID), .text(id)],
					database: database,
				)
			}
		}
		return candidates.count
	}

	func clearCachedArticles(accountID: String) throws {
		let database = try openDatabase()
		try transaction(database) {
			try execute("DELETE FROM cached_collection_articles WHERE account_id = ?", bindings: [.text(accountID)], database: database)
			try execute("DELETE FROM cached_articles WHERE account_id = ?", bindings: [.text(accountID)], database: database)
			try execute("DELETE FROM cached_collection_pagination WHERE account_id = ?", bindings: [.text(accountID)], database: database)
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

	private func apply(_ change: IncrementalSyncChange, accountID: String, database: OpaquePointer) throws {
		switch change.entityType {
		case .feed:
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
				let feedKey = payload.feedKey, let streamID = payload.streamId, let title = payload.title else {
				try execute("DELETE FROM cached_feeds WHERE account_id = ? AND feed_key = ?", bindings: [.text(accountID), .text(change.entityId)], database: database)
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
					accountID: accountID,
					database: database,
				)
				return
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
				accountID: accountID,
				database: database,
			)
		case .article:
			guard change.operation == .upsert, let payload = change.payload,
				let id = payload.id, let readerID = payload.readerId, let feedKey = payload.feedKey,
				let source = payload.source, let title = payload.title, let receivedAt = payload.receivedAt else {
				try deleteArticle(identifier: change.entityId, accountID: accountID, database: database)
				return
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
			try rebuildMemberships(for: storedArticle, accountID: accountID, database: database)
		case .status:
			guard change.operation == .upsert, let payload = change.payload else { return }
			try updateStatus(
				articleID: payload.itemId ?? change.entityId,
				isRead: payload.isRead,
				isStarred: payload.isStarred,
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
				let payload = data(at: 1, statement: statement),
				let article = try? decoder.decode(Recommendation.self, from: payload) else {
				return
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
				let payload = data(at: 1, statement: statement),
				let article = try? decoder.decode(Recommendation.self, from: payload) else {
				return
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
			guard let payload = data(at: 0, statement: statement),
				let subscription = try? decoder.decode(FeedSubscription.self, from: payload) else {
				return
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
			let existing = try loadStoredArticles(
				readerID: readerID,
				accountID: accountID,
				database: database,
			)
			guard existing.count > 1 else { continue }
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

	private func reconcileFeedMemberships(
		forFeedKeys feedKeys: Set<String>,
		previousSubscriptions: [FeedSubscription],
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
				accountID: accountID,
				database: database,
			)
		}
	}

	private func updateStatus(
		articleID: String,
		isRead: Bool?,
		isStarred: Bool?,
		accountID: String,
		database: OpaquePointer,
	) throws {
		guard var article = try loadArticle(identifier: articleID, accountID: accountID, database: database)?.article else {
			return
		}
		article.isRead = isRead ?? article.isRead
		article.isStarred = isStarred ?? article.isStarred
		let storedArticle = try upsertArticle(article, accountID: accountID, database: database)
		try rebuildMemberships(for: storedArticle, accountID: accountID, database: database)
	}

	private func rebuildMemberships(
		for article: Recommendation,
		staleSubscriptions: [FeedSubscription] = [],
		accountID: String,
		database: OpaquePointer,
	) throws {
		let managedCollections = [ReaderSection.unread.rawValue, ReaderSection.today.rawValue, ReaderSection.starred.rawValue]
		for collectionID in managedCollections {
			try execute(
				"DELETE FROM cached_collection_articles WHERE account_id = ? AND collection_id = ? AND article_id = ?",
				bindings: [.text(accountID), .text(collectionID), .text(article.id)], database: database,
			)
		}
		if article.isRead == false {
			try insertCollectionMembership(accountID: accountID, collectionID: ReaderSection.unread.rawValue, articleID: article.id, position: 0, database: database)
		}
		if ReaderLocalDayBounds.localDay(containing: .now).contains(article.receivedAt) {
			try insertCollectionMembership(accountID: accountID, collectionID: ReaderSection.today.rawValue, articleID: article.id, position: 0, database: database)
		}
		if article.isStarred {
			try insertCollectionMembership(accountID: accountID, collectionID: ReaderSection.starred.rawValue, articleID: article.id, position: 0, database: database)
		}

		let currentSubscriptions = try cachedSubscriptions(
			feedKey: article.feedKey,
			accountID: accountID,
			database: database,
		)
		let currentCollectionIDs = collectionIDs(for: currentSubscriptions)
		let staleCollectionIDs = collectionIDs(for: staleSubscriptions)
		let navigationCollectionIDs = try cachedNavigationCollectionIDs(
			feedKeys: [article.feedKey],
			accountID: accountID,
			database: database,
		)
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
		try cacheNavigationItems(navigation, accountID: accountID, database: database)
		var cachedArticles: [Recommendation] = []
		try query(
			"SELECT payload FROM cached_articles WHERE account_id = ?",
			bindings: [.text(accountID)], database: database,
		) { statement in
			if let payload = data(at: 0, statement: statement),
				let article = try? decoder.decode(Recommendation.self, from: payload) {
				cachedArticles.append(article)
			}
		}
		for article in cachedArticles {
			try rebuildMemberships(for: article, accountID: accountID, database: database)
		}
		return navigation
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
			"CREATE TABLE IF NOT EXISTS sync_state (account_id TEXT PRIMARY KEY, cursor TEXT, last_sync_at REAL)",
			"CREATE TABLE IF NOT EXISTS pending_actions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at REAL NOT NULL, UNIQUE (account_id, id))",
			"CREATE INDEX IF NOT EXISTS idx_pending_actions_account ON pending_actions(account_id, sequence)",
			"CREATE TABLE IF NOT EXISTS reader_state (account_id TEXT PRIMARY KEY, payload BLOB NOT NULL, updated_at REAL NOT NULL)",
		]
		for sql in statements { try execute(sql, database: database) }
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
}

nonisolated(unsafe) private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

nonisolated enum OfflineLibraryError: LocalizedError {
	case openFailed
	case sqlite(String)

	var errorDescription: String? {
		switch self {
		case .openFailed: "Pigeon could not open its offline library."
		case .sqlite(let message): "Pigeon could not update its offline library: \(message)"
		}
	}
}
