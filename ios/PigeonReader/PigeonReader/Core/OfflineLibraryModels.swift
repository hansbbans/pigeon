import Foundation

nonisolated struct IncrementalSyncPage: Codable, Equatable, Sendable {
	let cursor: String
	let hasMore: Bool
	let changes: [IncrementalSyncChange]
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

nonisolated enum ReaderSearchScope: String, CaseIterable, Identifiable, Sendable {
	case collection
	case library

	var id: Self { self }
	var title: String {
		switch self {
		case .collection: "This View"
		case .library: "Full Library"
		}
	}
}

nonisolated protocol OfflineLibraryStoring: Sendable {
	func loadSnapshot(accountID: String) async throws -> CachedLibrarySnapshot
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
	func apply(_ page: IncrementalSyncPage, accountID: String, dayBounds: ReaderLocalDayBounds?) async throws
	func finishSynchronization(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws
	func finishWarmSynchronization(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws
	func markDataSynchronizedWithoutNavigation(accountID: String, at date: Date, dayBounds: ReaderLocalDayBounds?) async throws
	func markCacheRepairNeeded(accountID: String, message: String, at date: Date) async throws
	func recordSynchronizationFailure(accountID: String, message: String, at date: Date) async throws
	func storageStats(accountID: String) async throws -> OfflineStorageStats
	func cleanupReadBodies(accountID: String, keepingNewest count: Int) async throws -> Int
	func clearCachedArticles(accountID: String) async throws
	func searchArticles(query: String, collectionID: String?, accountID: String, limit: Int) async throws -> [Recommendation]
}

extension OfflineLibraryStoring {
	func beginFullRebuild(accountID: String, at date: Date) async throws {}

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
