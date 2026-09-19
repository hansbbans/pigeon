import Foundation

/// A small value cache used by the pipeline. It is intentionally generic so
/// its eviction behavior can be tested without constructing UIKit images.
nonisolated struct ReaderFeedThumbnailMemoryCache<Key: Hashable, Value> {
	private struct Entry {
		let value: Value
		let cost: Int
	}

	private let capacity: Int
	private let byteCapacity: Int
	private var entries: [Key: Entry] = [:]
	private var leastRecentlyUsed: [Key] = []
	private(set) var totalCost = 0

	init(capacity: Int = 24, byteCapacity: Int = 4 * 1_024 * 1_024) {
		self.capacity = max(capacity, 1)
		self.byteCapacity = max(byteCapacity, 1)
	}

	var count: Int { entries.count }

	mutating func value(for key: Key) -> Value? {
		guard let entry = entries[key] else { return nil }
		touch(key)
		return entry.value
	}

	mutating func insert(_ value: Value, for key: Key, cost: Int) {
		if let existing = entries[key] {
			totalCost -= existing.cost
		}
		entries[key] = Entry(value: value, cost: max(cost, 1))
		totalCost += max(cost, 1)
		touch(key)
		trimToCapacity()
	}

	mutating func removeAll() {
		entries.removeAll()
		leastRecentlyUsed.removeAll()
		totalCost = 0
	}

	mutating func removeAll(where shouldRemove: (Key) -> Bool) {
		for key in entries.keys where shouldRemove(key) {
			if let entry = entries.removeValue(forKey: key) {
				totalCost -= entry.cost
			}
		}
		leastRecentlyUsed.removeAll { shouldRemove($0) || entries[$0] == nil }
	}

	private mutating func touch(_ key: Key) {
		leastRecentlyUsed.removeAll { $0 == key }
		leastRecentlyUsed.append(key)
	}

	private mutating func trimToCapacity() {
		while (entries.count > capacity || totalCost > byteCapacity),
			let oldest = leastRecentlyUsed.first {
			leastRecentlyUsed.removeFirst()
			if let entry = entries.removeValue(forKey: oldest) {
				totalCost -= entry.cost
			}
		}
		leastRecentlyUsed.removeAll { entries[$0] == nil }
	}
}
