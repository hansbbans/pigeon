import Foundation
import SQLite3

/// The small metadata record used to paint the library shell before the
/// canonical offline cache has been hydrated. It deliberately contains no
/// article rows or bodies. `CachedLibrarySnapshot` remains the only complete
/// library representation.
nonisolated struct OfflineLibraryBootstrapSnapshot: Codable, Equatable, Sendable {
	static let currentFormatVersion = 1
	static let maximumNavigationItemCount = 4_096
	static let maximumSubscriptionCount = 4_096
	static let maximumPreferenceEntryCount = 4_096
	static let maximumEncodedByteCount = 512 * 1_024
	static let maximumSQLitePayloadByteCount = 512 * 1_024
	static let maximumSQLitePreferenceByteCount = 128 * 1_024

	let formatVersion: Int
	let accountID: String
	let generatedAt: Date
	let navigation: ReaderNavigationState?
	let subscriptions: [FeedSubscription]
	let preferences: OfflineLibraryBootstrapPreferences?
	/// The local day for which the persisted Today unread count is valid.
	let todayDayStart: Date?

	init(
		formatVersion: Int = Self.currentFormatVersion,
		accountID: String,
		generatedAt: Date = .now,
		navigation: ReaderNavigationState?,
		subscriptions: [FeedSubscription] = [],
		preferences: OfflineLibraryBootstrapPreferences? = nil,
		todayDayStart: Date? = nil,
	) {
		self.formatVersion = formatVersion
		self.accountID = accountID
		self.generatedAt = generatedAt
		self.navigation = navigation
		self.subscriptions = subscriptions
		self.preferences = preferences
		self.todayDayStart = todayDayStart
	}

	static func empty(accountID: String) -> Self {
		Self(accountID: accountID, navigation: nil)
	}

	var isStructurallyValid: Bool {
		guard formatVersion == Self.currentFormatVersion,
			accountID.isEmpty == false,
			let navigation,
			navigation.items.count <= Self.maximumNavigationItemCount,
			navigation.expandedFolderIDs.count <= Self.maximumNavigationItemCount,
			subscriptions.count <= Self.maximumSubscriptionCount,
			preferencesAreBounded,
			todayProvenanceIsPresent else {
			return false
		}
		guard navigation.items.allSatisfy({ $0.id.isEmpty == false }) else {
			return false
		}
		return true
	}

	/// Zero only the stale Today total after a local-day rollover. Other saved
	/// counts remain useful metadata and are copied unchanged.
	func normalizedForCurrentLocalDay(now: Date = .now) -> Self? {
		guard isStructurallyValid, let navigation else { return nil }
		let currentDayStart = ReaderLocalDayBounds.localDay(containing: now).start
		guard let todayDayStart, todayDayStart != currentDayStart else {
			return self
		}
		return Self(
			formatVersion: formatVersion,
			accountID: accountID,
			generatedAt: generatedAt,
			navigation: navigation.replacingCount(for: ReaderSection.today.rawValue, with: 0),
			subscriptions: subscriptions,
			preferences: preferences,
			todayDayStart: currentDayStart,
		)
	}

	private var preferencesAreBounded: Bool {
		guard let preferences else { return true }
		return preferences.sortOrders.count <= Self.maximumPreferenceEntryCount
			&& preferences.articleFilters.count <= Self.maximumPreferenceEntryCount
			&& preferences.expandedFolderIDs.count <= Self.maximumNavigationItemCount
	}

	private var todayProvenanceIsPresent: Bool {
		let hasToday = navigation?.items.contains { $0.smartSection == .today } == true
		return hasToday == false || todayDayStart != nil
	}
}

/// Only the presentation settings needed to make the Home shell feel like the
/// previous launch are kept synchronously. Article selection, reader modes,
/// and scroll offsets are restored by the canonical snapshot later.
nonisolated struct OfflineLibraryBootstrapPreferences: Codable, Equatable, Sendable {
	let sortOrders: [String: String]
	let articleFilters: [String: String]
	let sidebarFilter: String
	let expandedFolderIDs: Set<String>

	init(
		sortOrders: [String: String] = [:],
		articleFilters: [String: String] = [:],
		sidebarFilter: String = ReaderSidebarFilter.all.rawValue,
		expandedFolderIDs: Set<String> = [],
	) {
		self.sortOrders = sortOrders
		self.articleFilters = articleFilters
		self.sidebarFilter = sidebarFilter
		self.expandedFolderIDs = expandedFolderIDs
	}
}

/// The synchronous read boundary used by `ReaderAppModel` during construction.
/// Implementations must be cheap and side-effect free; canonical writes stay on
/// `OfflineLibraryStore`'s actor.
nonisolated protocol OfflineLibraryBootstrapProviding: Sendable {
	func loadBootstrapSnapshot(accountID: String) -> OfflineLibraryBootstrapSnapshot?
}

/// Stores one account-scoped metadata file beside a particular SQLite cache.
/// The database filename is part of the sidecar filename so two configured
/// databases in one directory cannot share startup state.
nonisolated struct OfflineLibraryBootstrapFileStore: OfflineLibraryBootstrapProviding, Sendable {
	private final class LockBox: @unchecked Sendable {
		let lock = NSLock()
	}

	private final class LockRegistry: @unchecked Sendable {
		private let registryLock = NSLock()
		private var boxes: [String: LockBox] = [:]

		func box(for databaseURL: URL?) -> LockBox {
			let key = databaseURL?.standardizedFileURL.path(percentEncoded: false) ?? "<memory>"
			registryLock.lock()
			defer { registryLock.unlock() }
			if let box = boxes[key] {
				return box
			}
			let box = LockBox()
			boxes[key] = box
			return box
		}
	}

	private static let lockRegistry = LockRegistry()

	let databaseURL: URL?
	private let lockBox: LockBox

	init(databaseURL: URL?) {
		self.databaseURL = databaseURL
		self.lockBox = Self.lockRegistry.box(for: databaseURL)
	}

	func loadBootstrapSnapshot(accountID: String) -> OfflineLibraryBootstrapSnapshot? {
		guard accountID.isEmpty == false else { return nil }
		// Never make the MainActor wait behind a canonical metadata write. A
		// concurrent writer will leave the previous sidecar or SQLite metadata for
		// the next model construction.
		guard lockBox.lock.try() else { return nil }
		defer { lockBox.lock.unlock() }
		if let snapshot = readSidecar(accountID: accountID) {
			return snapshot.normalizedForCurrentLocalDay()
		}
		// Existing installations do not have a sidecar yet. This fallback reads
		// only navigation metadata and subscriptions, never cached_articles.
		guard let metadata = readMetadataFromSQLite(accountID: accountID) else {
			return nil
		}
		return snapshot(from: metadata, accountID: accountID).normalizedForCurrentLocalDay()
	}

	func update(
		accountID: String,
		_ update: (inout OfflineLibraryBootstrapSnapshot) -> Void,
	) throws {
		guard databaseURL != nil, accountID.isEmpty == false else { return }
		lockBox.lock.lock()
		defer { lockBox.lock.unlock() }
		var snapshot = readSidecar(accountID: accountID)
			?? readMetadataFromSQLite(accountID: accountID).map { metadata in
				self.snapshot(from: metadata, accountID: accountID)
			}
			?? .empty(accountID: accountID)
		update(&snapshot)
		do {
			try write(snapshot)
		} catch BootstrapWriteError.invalidMetadata, BootstrapWriteError.oversized {
			// Keeping an older record after an oversized replacement would make it
			// look current on the next launch. Canonical SQLite remains the fallback.
			removeSidecar()
			throw BootstrapWriteError.invalidMetadata
		}
	}

	func save(_ snapshot: OfflineLibraryBootstrapSnapshot) throws {
		guard databaseURL != nil else { return }
		lockBox.lock.lock()
		defer { lockBox.lock.unlock() }
		do {
			try write(snapshot)
		} catch BootstrapWriteError.invalidMetadata, BootstrapWriteError.oversized {
			removeSidecar()
			throw BootstrapWriteError.invalidMetadata
		}
	}

	func refreshMetadata(accountID: String) {
		guard accountID.isEmpty == false else { return }
		lockBox.lock.lock()
		defer { lockBox.lock.unlock() }
		guard let metadata = readMetadataFromSQLite(accountID: accountID),
			let navigation = metadata.navigation else {
			removeSidecar()
			return
		}
		let previous = readSidecar(accountID: accountID)
		let snapshot = OfflineLibraryBootstrapSnapshot(
			accountID: accountID,
			generatedAt: .now,
			navigation: navigation,
			subscriptions: metadata.subscriptions,
			preferences: metadata.preferences ?? previous?.preferences,
			todayDayStart: metadata.todayDayStart,
		)
		do {
			try write(snapshot)
		} catch BootstrapWriteError.invalidMetadata, BootstrapWriteError.oversized {
			removeSidecar()
		} catch {
			// A transient filesystem failure leaves the last complete record intact.
		}
	}

	func remove(accountID: String) {
		guard accountID.isEmpty == false else { return }
		lockBox.lock.lock()
		defer { lockBox.lock.unlock() }
		// There is one account record per database. Clearing the canonical account
		// must remove a stale, corrupt, or previously different-account record too.
		removeSidecar()
	}

	private enum BootstrapWriteError: Error {
		case invalidMetadata
		case oversized
	}

	private var fileURL: URL? {
		guard let databaseURL else { return nil }
		return databaseURL.deletingLastPathComponent().appending(
			path: "\(databaseURL.lastPathComponent).bootstrap.json",
		)
	}

	private func removeSidecar() {
		guard let fileURL else { return }
		try? FileManager.default.removeItem(at: fileURL)
	}

	private func readSidecar(accountID: String) -> OfflineLibraryBootstrapSnapshot? {
		guard let fileURL,
			let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path(percentEncoded: false)),
			let size = attributes[.size] as? NSNumber,
			size.intValue <= OfflineLibraryBootstrapSnapshot.maximumEncodedByteCount,
			let data = try? Data(contentsOf: fileURL),
			data.count <= OfflineLibraryBootstrapSnapshot.maximumEncodedByteCount,
			let snapshot = try? Self.makeDecoder().decode(OfflineLibraryBootstrapSnapshot.self, from: data),
			snapshot.accountID == accountID,
			snapshot.isStructurallyValid else {
			return nil
		}
		return snapshot
	}

	private func write(_ snapshot: OfflineLibraryBootstrapSnapshot) throws {
		guard snapshot.isStructurallyValid else {
			throw BootstrapWriteError.invalidMetadata
		}
		let data: Data
		do {
			data = try Self.makeEncoder().encode(snapshot)
		} catch {
			throw BootstrapWriteError.invalidMetadata
		}
		guard data.count <= OfflineLibraryBootstrapSnapshot.maximumEncodedByteCount else {
			throw BootstrapWriteError.oversized
		}
		guard let fileURL else { throw BootstrapWriteError.invalidMetadata }
		try FileManager.default.createDirectory(
			at: fileURL.deletingLastPathComponent(),
			withIntermediateDirectories: true,
		)
		try data.write(to: fileURL, options: [.atomic])
	}

	private static func makeEncoder() -> JSONEncoder {
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .iso8601
		return encoder
	}

	private static func makeDecoder() -> JSONDecoder {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return decoder
	}

	private struct Metadata: Sendable {
		let navigation: ReaderNavigationState?
		let subscriptions: [FeedSubscription]
		let preferences: OfflineLibraryBootstrapPreferences?
		let todayDayStart: Date?
	}

	private struct NavigationRecord: Sendable {
		let payload: Data
		let updatedAt: Date?
	}

	private struct RestorationProjection: Decodable {
		let sortOrders: [String: String]?
		let articleFilters: [String: String]?
		let sidebarFilter: String?
		let expandedFolderIDs: Set<String>?
	}

	private func snapshot(
		from metadata: Metadata,
		accountID: String,
	) -> OfflineLibraryBootstrapSnapshot {
		OfflineLibraryBootstrapSnapshot(
			accountID: accountID,
			generatedAt: .now,
			navigation: metadata.navigation,
			subscriptions: metadata.subscriptions,
			preferences: metadata.preferences,
			todayDayStart: metadata.todayDayStart,
		)
	}

	private func readMetadataFromSQLite(accountID: String) -> Metadata? {
		guard let databaseURL,
			FileManager.default.fileExists(atPath: databaseURL.path(percentEncoded: false)) else {
			return nil
		}
		var database: OpaquePointer?
		guard sqlite3_open_v2(
			databaseURL.path(percentEncoded: false),
			&database,
			SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX,
			nil,
		) == SQLITE_OK,
			let database else {
			if let database { sqlite3_close(database) }
			return nil
		}
		defer { sqlite3_close(database) }
		guard sqlite3_exec(database, "BEGIN DEFERRED", nil, nil, nil) == SQLITE_OK else {
			return nil
		}
		var transactionOpen = true
		defer {
			if transactionOpen {
				_ = sqlite3_exec(database, "ROLLBACK", nil, nil, nil)
			}
		}
		let metadataDecoder = Self.makeMetadataDecoder()
		let preferenceDecoder = Self.makePreferenceDecoder()

		guard let navigationRecord = queryRecord(
			"SELECT payload, updated_at FROM cached_navigation WHERE account_id = ?",
			accountID: accountID,
			database: database,
		),
			let navigation = try? metadataDecoder.decode(ReaderNavigationState.self, from: navigationRecord.payload),
			navigation.items.count <= OfflineLibraryBootstrapSnapshot.maximumNavigationItemCount,
			navigation.expandedFolderIDs.count <= OfflineLibraryBootstrapSnapshot.maximumNavigationItemCount else {
			return nil
		}

		let subscriptionCount = queryInteger(
			"SELECT COUNT(*) FROM cached_subscriptions WHERE account_id = ?",
			accountID: accountID,
			database: database,
		) ?? 0
		guard subscriptionCount <= OfflineLibraryBootstrapSnapshot.maximumSubscriptionCount else {
			return nil
		}
		guard let subscriptionPayloads = queryPayloads(
			"SELECT payload FROM cached_subscriptions WHERE account_id = ? ORDER BY title COLLATE NOCASE, id",
			accountID: accountID,
			database: database,
		),
			subscriptionPayloads.count == subscriptionCount else {
			return nil
		}
		let subscriptionPayloadBytes = subscriptionPayloads.reduce(0) { $0 + $1.count }
		guard subscriptionPayloadBytes <= OfflineLibraryBootstrapSnapshot.maximumEncodedByteCount,
			navigationRecord.payload.count <= OfflineLibraryBootstrapSnapshot.maximumEncodedByteCount - subscriptionPayloadBytes else {
			return nil
		}
		var subscriptions: [FeedSubscription] = []
		subscriptions.reserveCapacity(subscriptionPayloads.count)
		for payload in subscriptionPayloads {
			guard let subscription = try? metadataDecoder.decode(FeedSubscription.self, from: payload) else {
				return nil
			}
			subscriptions.append(subscription)
		}

		let preferences = queryRecord(
			"SELECT payload, updated_at FROM reader_state WHERE account_id = ?",
			accountID: accountID,
			database: database,
		).flatMap { record -> OfflineLibraryBootstrapPreferences? in
			guard record.payload.count <= OfflineLibraryBootstrapSnapshot.maximumSQLitePreferenceByteCount,
				let projection = try? preferenceDecoder.decode(RestorationProjection.self, from: record.payload) else {
				return nil
			}
			let sortOrders = projection.sortOrders ?? [:]
			let articleFilters = projection.articleFilters ?? [:]
			let expandedFolderIDs = projection.expandedFolderIDs ?? []
			guard sortOrders.count <= OfflineLibraryBootstrapSnapshot.maximumPreferenceEntryCount,
				articleFilters.count <= OfflineLibraryBootstrapSnapshot.maximumPreferenceEntryCount,
				expandedFolderIDs.count <= OfflineLibraryBootstrapSnapshot.maximumNavigationItemCount else {
				return nil
			}
			return OfflineLibraryBootstrapPreferences(
				sortOrders: sortOrders,
				articleFilters: articleFilters,
				sidebarFilter: projection.sidebarFilter ?? ReaderSidebarFilter.all.rawValue,
				expandedFolderIDs: expandedFolderIDs,
			)
		}

		let hasToday = navigation.items.contains { $0.smartSection == .today }
		let todayDayStart: Date?
		if hasToday {
			guard let updatedAt = navigationRecord.updatedAt else { return nil }
			todayDayStart = ReaderLocalDayBounds.localDay(containing: updatedAt).start
		} else {
			todayDayStart = nil
		}
		let metadata = Metadata(
			navigation: navigation,
			subscriptions: subscriptions,
			preferences: preferences,
			todayDayStart: todayDayStart,
		)
		guard sqlite3_exec(database, "COMMIT", nil, nil, nil) == SQLITE_OK else {
			return nil
		}
		transactionOpen = false
		return metadata
	}

	private func queryRecord(
		_ sql: String,
		accountID: String,
		database: OpaquePointer,
	) -> NavigationRecord? {
		var statement: OpaquePointer?
		guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
			let statement else { return nil }
		defer { sqlite3_finalize(statement) }
		guard sqlite3_bind_text(statement, 1, accountID, -1, bootstrapSQLiteTransient) == SQLITE_OK,
			sqlite3_step(statement) == SQLITE_ROW,
			sqlite3_column_type(statement, 0) != SQLITE_NULL,
			let bytes = sqlite3_column_blob(statement, 0) else { return nil }
		let byteCount = Int(sqlite3_column_bytes(statement, 0))
		guard byteCount <= OfflineLibraryBootstrapSnapshot.maximumSQLitePayloadByteCount else { return nil }
		let updatedAt: Date?
		if sqlite3_column_type(statement, 1) == SQLITE_NULL {
			updatedAt = nil
		} else {
			updatedAt = Date(timeIntervalSince1970: sqlite3_column_double(statement, 1))
		}
		return NavigationRecord(payload: Data(bytes: bytes, count: byteCount), updatedAt: updatedAt)
	}

	private func queryPayloads(
		_ sql: String,
		accountID: String,
		database: OpaquePointer,
	) -> [Data]? {
		var statement: OpaquePointer?
		guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
			let statement else { return nil }
		defer { sqlite3_finalize(statement) }
		guard sqlite3_bind_text(statement, 1, accountID, -1, bootstrapSQLiteTransient) == SQLITE_OK else {
			return nil
		}
		var payloads: [Data] = []
		var totalBytes = 0
		while true {
			let result = sqlite3_step(statement)
			if result == SQLITE_DONE {
				break
			}
			guard result == SQLITE_ROW else {
				return nil
			}
			guard sqlite3_column_type(statement, 0) != SQLITE_NULL,
				let bytes = sqlite3_column_blob(statement, 0) else {
				return nil
			}
			let byteCount = Int(sqlite3_column_bytes(statement, 0))
			guard byteCount <= OfflineLibraryBootstrapSnapshot.maximumSQLitePayloadByteCount,
				totalBytes <= OfflineLibraryBootstrapSnapshot.maximumEncodedByteCount - byteCount else {
				return nil
			}
			totalBytes += byteCount
			payloads.append(Data(bytes: bytes, count: byteCount))
		}
		return payloads
	}

	private func queryInteger(
		_ sql: String,
		accountID: String,
		database: OpaquePointer,
	) -> Int? {
		var statement: OpaquePointer?
		guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
			let statement else { return nil }
		defer { sqlite3_finalize(statement) }
		guard sqlite3_bind_text(statement, 1, accountID, -1, bootstrapSQLiteTransient) == SQLITE_OK,
			sqlite3_step(statement) == SQLITE_ROW else {
			return nil
		}
		return Int(sqlite3_column_int64(statement, 0))
	}

	private static func makeMetadataDecoder() -> JSONDecoder {
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
		return decoder
	}

	private static func makePreferenceDecoder() -> JSONDecoder {
		JSONDecoder()
	}
}

private nonisolated(unsafe) let bootstrapSQLiteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
