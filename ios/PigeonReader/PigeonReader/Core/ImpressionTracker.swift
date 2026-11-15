import Foundation

/// The impression rule for article lists, free of UI so it can be tested with
/// plain dates: an article counts as shown once its row has been at least half
/// inside the list viewport for one continuous second, at most once per list
/// session. Callers report what is at least half visible; time while paused
/// (scene not active, list covered by the reader) does not count.
nonisolated struct ImpressionTracker: Sendable {
	struct VisibleItem: Equatable, Sendable {
		let itemId: String
		/// 0-based rank in the list as displayed.
		let position: Int
	}

	struct Impression: Equatable, Sendable {
		let itemId: String
		let position: Int
		let sessionId: String
		let occurredAt: Date
	}

	static let minimumVisibleDuration: TimeInterval = 1

	private struct Sighting: Sendable {
		var since: Date
		var position: Int
	}

	private(set) var sessionId: String?
	private var sightings: [String: Sighting] = [:]
	private var loggedItemIDs: Set<String> = []
	private var pausedAt: Date?

	var isPaused: Bool { pausedAt != nil }

	/// When the earliest visible, not yet logged article qualifies if nothing
	/// changes. Nil while paused or when nothing is waiting.
	var nextQualificationDate: Date? {
		guard pausedAt == nil, let earliest = sightings.values.map(\.since).min() else { return nil }
		return earliest.addingTimeInterval(Self.minimumVisibleDuration)
	}

	/// Starts a list session. Articles logged in an earlier session count again.
	mutating func beginSession(id: String = UUID().uuidString.lowercased()) {
		sessionId = id
		sightings.removeAll(keepingCapacity: true)
		loggedItemIDs.removeAll(keepingCapacity: true)
		pausedAt = nil
	}

	/// Returns what qualified by `date`, then forgets the session.
	mutating func endSession(at date: Date) -> [Impression] {
		let qualified = collect(at: date)
		sessionId = nil
		sightings.removeAll(keepingCapacity: true)
		loggedItemIDs.removeAll(keepingCapacity: true)
		pausedAt = nil
		return qualified
	}

	/// Replaces the set of at-least-half-visible articles. Rows that left lose
	/// their timer; rows that stayed keep it and take the newest position.
	mutating func update(visible: [VisibleItem], at date: Date) -> [Impression] {
		guard sessionId != nil else { return [] }
		let since = pausedAt ?? date
		var stillVisible: [String: Sighting] = [:]
		stillVisible.reserveCapacity(visible.count)
		for item in visible where loggedItemIDs.contains(item.itemId) == false {
			stillVisible[item.itemId] = Sighting(since: sightings[item.itemId]?.since ?? since, position: item.position)
		}
		sightings = stillVisible
		return collect(at: date)
	}

	/// Articles that reached one continuous second by `date`, in list order.
	mutating func collect(at date: Date) -> [Impression] {
		guard let sessionId, pausedAt == nil, sightings.isEmpty == false else { return [] }
		var qualified: [Impression] = []
		for (itemId, sighting) in sightings {
			let qualifiedAt = sighting.since.addingTimeInterval(Self.minimumVisibleDuration)
			guard qualifiedAt <= date else { continue }
			qualified.append(Impression(
				itemId: itemId,
				position: sighting.position,
				sessionId: sessionId,
				occurredAt: qualifiedAt,
			))
		}
		for impression in qualified {
			sightings[impression.itemId] = nil
			loggedItemIDs.insert(impression.itemId)
		}
		return qualified.sorted {
			$0.position != $1.position ? $0.position < $1.position : $0.itemId < $1.itemId
		}
	}

	/// Stops the clock. Returns what had already qualified by `date`.
	mutating func pause(at date: Date) -> [Impression] {
		guard pausedAt == nil else { return [] }
		let qualified = collect(at: date)
		pausedAt = date
		return qualified
	}

	/// Restarts the clock: every waiting row keeps the time it had before the
	/// pause, and rows that appeared during it start from `date`.
	mutating func resume(at date: Date) {
		guard let pausedAt else { return }
		let pausedFor = max(0, date.timeIntervalSince(pausedAt))
		for itemId in sightings.keys {
			sightings[itemId]?.since.addTimeInterval(pausedFor)
		}
		self.pausedAt = nil
	}
}
