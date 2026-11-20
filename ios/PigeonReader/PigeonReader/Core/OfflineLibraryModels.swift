import Foundation

nonisolated struct IncrementalSyncPage: Codable, Equatable, Sendable {
	let cursor: String
	let hasMore: Bool
	let changes: [IncrementalSyncChange]
}

/// One page of `GET /api/v1/library`: the unread-first listing that rebuilds
/// the offline library. Articles carry metadata only; their bodies come from
/// How a full rebuild started: `startedAt` identifies its staging generation
/// (pass it to `abandonFullRebuild`). `listingContinuation` is nil for a
/// fresh rebuild, `""` when a resumed listing had already finished, and
/// otherwise the continuation to request next.
nonisolated struct OfflineRebuildStart: Equatable, Sendable {
	let startedAt: Date
	let listingContinuation: String?
}

/// `POST /api/v1/library/articles`. `snapshotCursor` is the `/api/v1/sync`
/// cursor to continue from once the listing is complete.
nonisolated struct LibraryListingPage: Codable, Equatable, Sendable {
	let snapshotCursor: String
	let continuation: String?
	let feeds: [IncrementalSyncPayload]
	let articles: [IncrementalSyncPayload]

	/// The page as sync upserts (feeds before articles), so it goes through
	/// the same apply path as `/api/v1/sync`. `hasMore` mirrors whether the
	/// listing continues.
	func syncPage(changedAt: Date = .now) -> IncrementalSyncPage {
		let feedChanges = feeds.map { payload in
			IncrementalSyncChange(
				sequence: 0, entityType: .feed, entityId: payload.feedKey ?? "", operation: .upsert,
				changedAt: changedAt, payload: payload,
			)
		}
		let articleChanges = articles.map { payload in
			IncrementalSyncChange(
				sequence: 0, entityType: .article, entityId: payload.id ?? "", operation: .upsert,
				changedAt: changedAt, payload: payload,
			)
		}
		return IncrementalSyncPage(cursor: snapshotCursor, hasMore: continuation != nil, changes: feedChanges + articleChanges)
	}
}

/// `POST /api/v1/library/articles`: full article payloads in request order,
/// trimmed to the server's page budget. Ids in `missing` no longer exist;
/// ids in neither list were trimmed and can be requested again.
nonisolated struct LibraryArticlesResponse: Codable, Equatable, Sendable {
	let articles: [IncrementalSyncPayload]
	let missing: [String]
}

nonisolated struct IncrementalSyncChange: Codable, Equatable, Sendable {
	enum EntityType: String, Codable, Sendable {
		case feed
		case article
		case status
	}

	enum Operation: String, Codable, Sendable {
		case upsert
		case delete
	}

	let sequence: Int64
	let entityType: EntityType
	let entityId: String
	let operation: Operation
	let changedAt: Date
	let payload: IncrementalSyncPayload?
}

/// One tolerant payload type keeps a malformed entity from making unrelated
/// changes undecodable while still giving every supported field a concrete type.
nonisolated struct IncrementalSyncPayload: Codable, Equatable, Sendable {
	let feedKey: String?
	let streamId: String?
	let title: String?
	let feedURL: URL?
	let siteURL: URL?
	let iconURL: URL?
	let isActive: Bool?
	let folders: [String]?

	let id: String?
	let readerId: String?
	let source: String?
	let author: String?
	let html: String?
	let text: String?
	let originalURL: URL?
	let receivedAt: Date?
	let isRead: Bool?
	let isStarred: Bool?
	let isBodyPruned: Bool?
	var isPaywalled: Bool? = nil
	var wordCount: Int? = nil
	var mediaKind: String? = nil
	var durationSeconds: Int? = nil

	/// Feed payloads: "email", "rss" or "saved" (Read It Later).
	var sourceType: String? = nil
	// Read It Later article fields. Strings, not URL/Date, so one odd value
	// can never make the whole sync page undecodable.
	var extractionState: String? = nil
	var publishedAt: String? = nil
	var imageURL: String? = nil
	var siteName: String? = nil
	/// Present (and `true`) only when the server stores a transcript for the item.
	var hasTranscript: Bool? = nil

	var length: ArticleLength? {
		ArticleLength(wordCount: wordCount, mediaKind: mediaKind, durationSeconds: durationSeconds)
	}

	var savedMetadata: SavedArticleMetadata? {
		SavedArticleMetadata(
			extractionState: extractionState,
			publishedAt: publishedAt.flatMap(SavedArticleMetadata.parseDate),
			imageURL: imageURL.flatMap(URL.init(string:)),
			siteName: siteName,
		)
	}

	let itemId: String?
	let updatedAt: Date?
	let version: Int?
	let mutationId: String?
}

nonisolated enum OfflineMutationKind: String, Codable, Sendable {
	case setRead = "set_read"
	case setStarred = "set_starred"
	case setReadBatch = "set_read_batch"
	case feedback
	case renameFeed = "rename_feed"
	case moveFeed = "move_feed"
	case unsubscribeFeed = "unsubscribe_feed"
	case restoreFeed = "restore_feed"
	case setWordCount = "set_word_count"
	case removeSaved = "remove_saved"
}

nonisolated enum OfflineMutationScope: String, Codable, Sendable {
	case single
	case all
	case above
	case below
	case older
}

nonisolated struct OfflineMutation: Codable, Equatable, Identifiable, Sendable {
	let id: String
	let kind: OfflineMutationKind
	var itemIds: [String] = []
	var value: Bool?
	var feedback: String?
	var feedId: String?
	var title: String?
	var folders: [String]?
	var scope: OfflineMutationScope?
	/// For `set_word_count`: the reader-mode extraction's word count.
	var wordCount: Int?

	init(
		id: String = UUID().uuidString.lowercased(),
		kind: OfflineMutationKind,
		itemIds: [String] = [],
		value: Bool? = nil,
		feedback: String? = nil,
		feedId: String? = nil,
		title: String? = nil,
		folders: [String]? = nil,
		scope: OfflineMutationScope? = nil,
		wordCount: Int? = nil,
	) {
		self.id = id
		self.kind = kind
		self.itemIds = itemIds
		self.value = value
		self.feedback = feedback
		self.feedId = feedId
		self.title = title
		self.folders = folders
		self.scope = scope
		self.wordCount = wordCount
	}
}

nonisolated struct OfflineMutationEnvelope: Codable, Sendable {
	let mutations: [OfflineMutation]
}

nonisolated struct OfflineMutationBatchResponse: Codable, Equatable, Sendable {
	let results: [OfflineMutationResult]
}

nonisolated struct OfflineMutationResult: Codable, Equatable, Sendable {
	enum Status: String, Codable, Sendable {
		case applied
		case alreadyApplied = "already_applied"
		case failed
	}

	let mutationId: String
	let status: Status
	let appliedAt: Date?
	let error: String?
}

nonisolated struct PendingOfflineMutation: Codable, Equatable, Sendable {
	let sequence: Int64
	let mutation: OfflineMutation
	let attempts: Int
	let lastError: String?
	let createdAt: Date
}

nonisolated enum ReaderRestoredCompactColumn: String, Codable, Sendable {
	case sidebar
	case content
	case detail
}

nonisolated struct ReaderRestorationState: Codable, Equatable, Sendable {
	var selectedNavigationID: String
	var selectedArticleIDs: [String: String]
	var sortOrders: [String: String]
	var articleFilters: [String: String]
	var sidebarFilter: String
	var expandedFolderIDs: Set<String>
	var compactColumn: ReaderRestoredCompactColumn
	var readerModes: [String: String]
	var articleScrollOffsets: [String: Double]
	/// The order supplied by the server for collections whose response carries
	/// meaning beyond local fields (currently For You). It survives local sort
	/// toggles and offline cache restoration.
	var canonicalArticleOrder: [String: [String]]

	private enum CodingKeys: String, CodingKey {
		case selectedNavigationID
		case selectedArticleIDs
		case sortOrders
		case articleFilters
		case sidebarFilter
		case expandedFolderIDs
		case compactColumn
		case readerModes
		case articleScrollOffsets
		case canonicalArticleOrder
	}

	init(
		selectedNavigationID: String,
		selectedArticleIDs: [String: String],
		sortOrders: [String: String],
		articleFilters: [String: String],
		sidebarFilter: String,
		expandedFolderIDs: Set<String>,
		compactColumn: ReaderRestoredCompactColumn,
		readerModes: [String: String],
		articleScrollOffsets: [String: Double],
		canonicalArticleOrder: [String: [String]] = [:],
	) {
		self.selectedNavigationID = selectedNavigationID
		self.selectedArticleIDs = selectedArticleIDs
		self.sortOrders = sortOrders
		self.articleFilters = articleFilters
		self.sidebarFilter = sidebarFilter
		self.expandedFolderIDs = expandedFolderIDs
		self.compactColumn = compactColumn
		self.readerModes = readerModes
		self.articleScrollOffsets = articleScrollOffsets
		self.canonicalArticleOrder = canonicalArticleOrder
	}

	init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		selectedNavigationID = try container.decode(String.self, forKey: .selectedNavigationID)
		selectedArticleIDs = try container.decode([String: String].self, forKey: .selectedArticleIDs)
		sortOrders = try container.decode([String: String].self, forKey: .sortOrders)
		articleFilters = try container.decode([String: String].self, forKey: .articleFilters)
		sidebarFilter = try container.decode(String.self, forKey: .sidebarFilter)
		expandedFolderIDs = try container.decode(Set<String>.self, forKey: .expandedFolderIDs)
		compactColumn = try container.decode(ReaderRestoredCompactColumn.self, forKey: .compactColumn)
		readerModes = try container.decode([String: String].self, forKey: .readerModes)
		articleScrollOffsets = try container.decode([String: Double].self, forKey: .articleScrollOffsets)
		canonicalArticleOrder = try container.decodeIfPresent([String: [String]].self, forKey: .canonicalArticleOrder) ?? [:]
	}

	func encode(to encoder: Encoder) throws {
		var container = encoder.container(keyedBy: CodingKeys.self)
		try container.encode(selectedNavigationID, forKey: .selectedNavigationID)
		try container.encode(selectedArticleIDs, forKey: .selectedArticleIDs)
		try container.encode(sortOrders, forKey: .sortOrders)
		try container.encode(articleFilters, forKey: .articleFilters)
		try container.encode(sidebarFilter, forKey: .sidebarFilter)
		try container.encode(expandedFolderIDs, forKey: .expandedFolderIDs)
		try container.encode(compactColumn, forKey: .compactColumn)
		try container.encode(readerModes, forKey: .readerModes)
		try container.encode(articleScrollOffsets, forKey: .articleScrollOffsets)
		try container.encode(canonicalArticleOrder, forKey: .canonicalArticleOrder)
	}

	static let initial = ReaderRestorationState(
		selectedNavigationID: ReaderSection.forYou.rawValue,
		selectedArticleIDs: [:],
		sortOrders: [:],
		articleFilters: [:],
		sidebarFilter: ReaderSidebarFilter.all.rawValue,
		expandedFolderIDs: [],
		compactColumn: .sidebar,
		readerModes: [:],
		articleScrollOffsets: [:],
	)
}

nonisolated enum OfflineCacheState: String, Codable, Equatable, Sendable {
	case needsBootstrap = "needs_bootstrap"
	case syncing
	case complete
	case needsRepair = "needs_repair"
}

nonisolated enum OfflineNavigationFreshness: String, Codable, Equatable, Sendable {
	case unverified
	case authoritative
}

nonisolated enum OfflineLibraryStatus: Equatable, Sendable {
	case syncing
	case repairing
	case upToDate
	case waitingToSync
	case offline
	case syncFailed
	case needsRepair
}

nonisolated struct OfflineCacheIntegrity: Codable, Equatable, Sendable {
	static let currentFormatVersion = 1

	let formatVersion: Int
	let state: OfflineCacheState
	let navigation: OfflineNavigationFreshness
	let lastAttemptAt: Date?
	let lastSuccessAt: Date?
	let lastError: String?
	let invalidChangeCount: Int
	let lastPageHasMore: Bool?

	static let needsBootstrap = Self(
		formatVersion: 0,
		state: .needsBootstrap,
		navigation: .unverified,
		lastAttemptAt: nil,
		lastSuccessAt: nil,
		lastError: nil,
		invalidChangeCount: 0,
		lastPageHasMore: nil,
	)

	var usesWarmIncrementalPath: Bool {
		formatVersion == Self.currentFormatVersion
			&& state == .complete
			&& navigation == .authoritative
	}

	var requiresFullRebuild: Bool {
		formatVersion != Self.currentFormatVersion
			|| state == .needsBootstrap
			|| state == .syncing
			|| state == .needsRepair
	}
}

nonisolated struct CachedLibrarySnapshot: Sendable {
	let navigation: ReaderNavigationState?
	let subscriptions: [FeedSubscription]
	let articlesByCollection: [String: [Recommendation]]
	let continuationsByCollection: [String: String]
	let restoration: ReaderRestorationState?
	let cursor: String?
	let lastSyncAt: Date?
	let integrity: OfflineCacheIntegrity

	var isEmpty: Bool {
		navigation == nil && subscriptions.isEmpty && articlesByCollection.isEmpty
	}
}

nonisolated struct OfflineStorageStats: Equatable, Sendable {
	let articleCount: Int
	let bodyBytes: Int64
	let pendingMutationCount: Int
	let lastSyncAt: Date?
	let cacheState: OfflineCacheState
	let navigationFreshness: OfflineNavigationFreshness
	let lastAttemptAt: Date?
	let lastSuccessAt: Date?
	let lastError: String?

	init(
		articleCount: Int,
		bodyBytes: Int64,
		pendingMutationCount: Int,
		lastSyncAt: Date?,
		cacheState: OfflineCacheState = .needsBootstrap,
		navigationFreshness: OfflineNavigationFreshness = .unverified,
		lastAttemptAt: Date? = nil,
		lastSuccessAt: Date? = nil,
		lastError: String? = nil,
	) {
		self.articleCount = articleCount
		self.bodyBytes = bodyBytes
		self.pendingMutationCount = pendingMutationCount
		self.lastSyncAt = lastSyncAt
		self.cacheState = cacheState
		self.navigationFreshness = navigationFreshness
		self.lastAttemptAt = lastAttemptAt
		self.lastSuccessAt = lastSuccessAt
		self.lastError = lastError
	}

	static let empty = OfflineStorageStats(articleCount: 0, bodyBytes: 0, pendingMutationCount: 0, lastSyncAt: nil)
}

nonisolated protocol OfflineLibraryStoring: Sendable {
	func loadSnapshot(accountID: String) async throws -> CachedLibrarySnapshot
	func loadSnapshot(accountID: String, collectionIDs: Set<String>) async throws -> CachedLibrarySnapshot
	func saveNavigation(_ navigation: ReaderNavigationState, accountID: String) async throws
	func saveSubscriptions(_ subscriptions: [FeedSubscription], accountID: String) async throws
	func saveArticles(_ articles: [Recommendation], collectionID: String, accountID: String) async throws
	func saveCollectionContinuation(_ continuation: String?, collectionID: String, accountID: String) async throws
	func saveRestoration(_ restoration: ReaderRestorationState, accountID: String) async throws
	func enqueue(_ mutation: OfflineMutation, accountID: String) async throws
	func pendingMutations(accountID: String, limit: Int) async throws -> [PendingOfflineMutation]
	func markMutationApplied(id: String, accountID: String) async throws
	func recordMutationFailure(id: String, message: String, accountID: String) async throws
	func apply(_ page: IncrementalSyncPage, accountID: String) async throws
	func beginFullRebuild(accountID: String, at date: Date) async throws
	/// Starts a rebuild or re-attaches the listing rebuild an earlier launch left.
	func beginOrResumeFullRebuild(accountID: String, at date: Date, maxAge: TimeInterval) async throws -> OfflineRebuildStart
	func applyLibraryListingPage(_ page: LibraryListingPage, accountID: String, dayBounds: ReaderLocalDayBounds?) async throws
	/// Abandon only the caller's in-progress rebuild generation. The durable marker
	/// and staged rows remain available for cleanup by the next rebuild attempt.
	func abandonFullRebuild(accountID: String, startedAt: Date) async throws
	func apply(_ page: IncrementalSyncPage, accountID: String, dayBounds: ReaderLocalDayBounds?) async throws
	/// Sequences of the feed changes in `page` that repeat what is already cached.
	func unchangedFeedChangeSequences(in page: IncrementalSyncPage, accountID: String) async throws -> Set<Int64>
	func finishSynchronization(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws
	func finishWarmSynchronization(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws
	func markDataSynchronizedWithoutNavigation(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws
	func markCacheRepairNeeded(accountID: String, message: String, at date: Date) async throws
	func recordSynchronizationFailure(accountID: String, message: String, at date: Date) async throws
	func storageStats(accountID: String) async throws -> OfflineStorageStats
	func cleanupReadBodies(accountID: String, keepingNewest count: Int) async throws -> Int
	func clearCachedArticles(accountID: String) async throws
	func searchArticles(query: String, collectionID: String?, accountID: String, limit: Int) async throws -> [Recommendation]
	func removeArticles(ids: [String], accountID: String) async throws
	func articleIDsNeedingFetch(accountID: String, limit: Int) async throws -> [String]
	func applyFetchedArticles(_ articles: [IncrementalSyncPayload], accountID: String, dayBounds: ReaderLocalDayBounds?) async throws -> [Recommendation]
	func markArticlesUnavailable(ids: [String], accountID: String) async throws
}

extension OfflineLibraryStoring {
	/// Test doubles without article rows have nothing to remove.
	func removeArticles(ids: [String], accountID: String) async throws {}

	/// Test doubles without article rows have nothing to fetch.
	func articleIDsNeedingFetch(accountID: String, limit: Int) async throws -> [String] { [] }

	func applyFetchedArticles(_ articles: [IncrementalSyncPayload], accountID: String, dayBounds: ReaderLocalDayBounds?) async throws -> [Recommendation] { [] }

	func markArticlesUnavailable(ids: [String], accountID: String) async throws {}

	/// Lightweight stores cannot resume a rebuild; they always start over.
	func beginOrResumeFullRebuild(accountID: String, at date: Date, maxAge: TimeInterval) async throws -> OfflineRebuildStart {
		try await beginFullRebuild(accountID: accountID, at: date)
		return OfflineRebuildStart(startedAt: date, listingContinuation: nil)
	}

	func applyLibraryListingPage(_ page: LibraryListingPage, accountID: String, dayBounds: ReaderLocalDayBounds?) async throws {
		try await apply(page.syncPage(), accountID: accountID, dayBounds: dayBounds)
	}

	/// A store that cannot tell treats every feed change as a change.
	func unchangedFeedChangeSequences(in page: IncrementalSyncPage, accountID: String) async throws -> Set<Int64> {
		[]
	}

	/// Compatibility fallback for lightweight stores and test doubles. The SQLite
	/// implementation overrides this with a scoped membership query.
	func loadSnapshot(accountID: String, collectionIDs: Set<String>) async throws -> CachedLibrarySnapshot {
		let snapshot = try await loadSnapshot(accountID: accountID)
		let articlesByCollection = collectionIDs.reduce(into: [String: [Recommendation]]()) { result, collectionID in
			result[collectionID] = snapshot.articlesByCollection[collectionID] ?? []
		}
		let continuationsByCollection = collectionIDs.reduce(into: [String: String]()) { result, collectionID in
			if let continuation = snapshot.continuationsByCollection[collectionID] {
				result[collectionID] = continuation
			}
		}
		return CachedLibrarySnapshot(
			navigation: snapshot.navigation,
			subscriptions: snapshot.subscriptions,
			articlesByCollection: articlesByCollection,
			continuationsByCollection: continuationsByCollection,
			restoration: snapshot.restoration,
			cursor: snapshot.cursor,
			lastSyncAt: snapshot.lastSyncAt,
			integrity: snapshot.integrity,
		)
	}

	func beginFullRebuild(accountID: String, at date: Date) async throws {}

	func abandonFullRebuild(accountID: String, startedAt: Date) async throws {}

	func apply(_ page: IncrementalSyncPage, accountID: String, dayBounds: ReaderLocalDayBounds?) async throws {
		try await apply(page, accountID: accountID)
	}

	func finishSynchronization(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws {}

	func finishWarmSynchronization(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws {}

	func markDataSynchronizedWithoutNavigation(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws {}

	func markCacheRepairNeeded(accountID: String, message: String, at date: Date) async throws {}

	func recordSynchronizationFailure(accountID: String, message: String, at date: Date) async throws {}

	func apply(_ page: IncrementalSyncPage, accountID: String) async throws {
		try await apply(page, accountID: accountID, dayBounds: nil)
	}

	func beginFullRebuild(accountID: String) async throws {
		try await beginFullRebuild(accountID: accountID, at: .now)
	}

	func finishSynchronization(accountID: String) async throws {
		try await finishSynchronization(accountID: accountID, at: .now, dayBounds: nil)
	}

	func finishSynchronization(accountID: String, at date: Date) async throws {
		try await finishSynchronization(accountID: accountID, at: date, dayBounds: nil)
	}

	func finishWarmSynchronization(accountID: String, at date: Date) async throws {
		try await finishWarmSynchronization(accountID: accountID, at: date, dayBounds: nil)
	}

	func markDataSynchronizedWithoutNavigation(accountID: String) async throws {
		try await markDataSynchronizedWithoutNavigation(accountID: accountID, at: .now, dayBounds: nil)
	}

	func markDataSynchronizedWithoutNavigation(accountID: String, at date: Date) async throws {
		try await markDataSynchronizedWithoutNavigation(accountID: accountID, at: date, dayBounds: nil)
	}

	func markCacheRepairNeeded(accountID: String, message: String) async throws {
		try await markCacheRepairNeeded(accountID: accountID, message: message, at: .now)
	}

	func recordSynchronizationFailure(accountID: String, message: String) async throws {
		try await recordSynchronizationFailure(accountID: accountID, message: message, at: .now)
	}
}
