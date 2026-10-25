import Foundation

/// The reader API can identify one article with its internal row id, a Google
/// Reader tag id, or a feed response id. Keep aliases together so a body or
/// status update replaces the same canonical article in every collection.
nonisolated enum ReaderArticleIdentity {
	private static let googleReaderPrefix = "tag:google.com,2005:reader/item/"

	static func normalized(_ rawValue: String) -> String {
		// Most ids are already canonical. Bulk actions compare thousands of pairs,
		// so skip trimming and lowercasing when they would not change anything.
		if isCanonical(rawValue) { return rawValue }
		let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
		guard value.isEmpty == false else { return "" }
		if value.hasPrefix(googleReaderPrefix),
			let hexadecimal = UInt64(String(value.dropFirst(googleReaderPrefix.count)), radix: 16) {
			return String(hexadecimal)
		}
		return value.lowercased()
	}

	static func aliases(id: String, readerID: String) -> Set<String> {
		Set([normalized(id), normalized(readerID)].filter { $0.isEmpty == false })
	}

	static func key(for article: Recommendation) -> String {
		let readerID = normalized(article.readerId)
		if readerID.isEmpty == false { return readerID }
		return normalized(article.id)
	}

	static func matches(_ lhs: Recommendation, _ rhs: Recommendation) -> Bool {
		let rhsID = normalized(rhs.id)
		let rhsReaderID = normalized(rhs.readerId)
		return matches(normalized(lhs.id), rhsID, rhsReaderID)
			|| matches(normalized(lhs.readerId), rhsID, rhsReaderID)
	}

	static func matches(_ article: Recommendation, id: String) -> Bool {
		matches(normalized(id), normalized(article.id), normalized(article.readerId))
	}

	private static func matches(_ alias: String, _ first: String, _ second: String) -> Bool {
		alias.isEmpty == false && (alias == first || alias == second)
	}

	/// Plain lowercase ASCII without whitespace or the Google Reader prefix is
	/// already its own normalized form.
	private static func isCanonical(_ value: String) -> Bool {
		guard value.isEmpty == false, value.utf8.starts(with: googleReaderPrefix.utf8) == false else { return false }
		return value.utf8.allSatisfy { byte in
			byte > 0x20 && byte < 0x7F && (byte < 0x41 || byte > 0x5A)
		}
	}
}

nonisolated struct ReaderCollectionLoadKey: Hashable, Sendable {
	let accountID: String
	let collectionID: String
	let libraryGeneration: UUID
	let preparationID: UUID?
}

/// Shares one raw collection request between view-entry and lifecycle callers.
/// A waiter never owns the shared task, so cancelling one SwiftUI task cannot
/// cancel work another caller is still using.
@MainActor
final class ReaderCollectionLoadCoordinator {
	private var tasks: [ReaderCollectionLoadKey: Task<Bool, Never>] = [:]
	private var generations: [ReaderCollectionLoadKey: UUID] = [:]

	func run(
		for key: ReaderCollectionLoadKey,
		operation: @escaping @MainActor @Sendable () async -> Bool,
	) async -> Bool {
		if let existingTask = tasks[key] {
			return await existingTask.value
		}

		let generation = UUID()
		generations[key] = generation
		let task = Task { @MainActor [weak self] in
			let succeeded = await operation()
			if let self, self.generations[key] == generation {
				self.tasks[key] = nil
				self.generations[key] = nil
			}
			return succeeded
		}
		tasks[key] = task
		return await task.value
	}

	func remove(collectionID: String) {
		// Personalization changes require a new recommendation snapshot. Existing
		// waiters can finish, but the model invalidates their commit ownership.
		for key in tasks.keys where key.collectionID == collectionID {
			tasks[key] = nil
			generations[key] = nil
		}
	}

	func removeAll() {
		// Requests remain alive; account/generation guards prevent stale commits.
		tasks.removeAll()
		generations.removeAll()
	}
}
