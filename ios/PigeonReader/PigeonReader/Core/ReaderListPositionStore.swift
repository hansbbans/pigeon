import Foundation

nonisolated struct ReaderListCollectionScope: Equatable, Sendable {
	let accountID: String
	let collectionID: String
}

nonisolated enum ReaderListContextContinuity {
	static func canHandoff(
		from source: ReaderListCollectionScope,
		to target: ReaderListCollectionScope,
	) -> Bool {
		source == target
	}
}

nonisolated struct ReaderListPosition: Equatable {
	let articleID: String
	let viewportOffset: Double
	let neighbors: [String]

	func target(in articleIDs: [String]) -> String? {
		let available = Set(articleIDs)
		return ([articleID] + neighbors).first(where: available.contains)
	}

}

@MainActor
final class ReaderListPositionStore {
	private var positions: [String: ReaderListPosition] = [:]
	private var recentKeys: [String] = []

	func position(for key: String) -> ReaderListPosition? { positions[key] }

	func removePosition(for key: String) {
		positions[key] = nil
		recentKeys.removeAll { $0 == key }
	}

	/// Copies a captured explicit-change anchor into a target context only when
	/// account and collection identity are unchanged. Ordinary navigation never
	/// calls this method and therefore continues to use the target's own
	/// position.
	@discardableResult
	func handoffPosition(
		_ position: ReaderListPosition,
		from sourceKey: String,
		to targetKey: String,
		sourceScope: ReaderListCollectionScope,
		targetScope: ReaderListCollectionScope,
	) -> Bool {
		guard sourceKey != targetKey,
			ReaderListContextContinuity.canHandoff(from: sourceScope, to: targetScope),
			positions[sourceKey] != nil else { return false }
		save(position, for: targetKey)
		return true
	}

	func save(_ position: ReaderListPosition, for key: String) {
		positions[key] = position
		recentKeys.removeAll { $0 == key }
		recentKeys.append(key)
		if recentKeys.count > 30 { positions[recentKeys.removeFirst()] = nil }
	}

	func reset() {
		positions.removeAll()
		recentKeys.removeAll()
	}
}
