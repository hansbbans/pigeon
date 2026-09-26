import Foundation

/// The reader API can identify one article with its internal row id, a Google
/// Reader tag id, or a feed response id. Keep aliases together so a body or
/// status update replaces the same canonical article in every collection.
nonisolated enum ReaderArticleIdentity {
	private static let googleReaderPrefix = "tag:google.com,2005:reader/item/"

	static func normalized(_ rawValue: String) -> String {
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
		!aliases(id: lhs.id, readerID: lhs.readerId)
			.isDisjoint(with: aliases(id: rhs.id, readerID: rhs.readerId))
	}

	static func matches(_ article: Recommendation, id: String) -> Bool {
		!aliases(id: article.id, readerID: article.readerId)
			.isDisjoint(with: Set([normalized(id)].filter { $0.isEmpty == false }))
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
	private var tasks: [ReaderCollectionLoadKey: Task<Void, Never>] = [:]
	private var generations: [ReaderCollectionLoadKey: UUID] = [:]

	func run(
		for key: ReaderCollectionLoadKey,
		operation: @escaping @MainActor @Sendable () async -> Void,
	) async {
		if let existingTask = tasks[key] {
			await existingTask.value
			return
		}

		let generation = UUID()
		generations[key] = generation
		let task = Task { @MainActor [weak self] in
			await operation()
			guard let self, self.generations[key] == generation else { return }
			self.tasks[key] = nil
			self.generations[key] = nil
		}
		tasks[key] = task
		await task.value
	}

	func removeAll() {
		// Requests remain alive; account/generation guards prevent stale commits.
		tasks.removeAll()
		generations.removeAll()
	}
}
