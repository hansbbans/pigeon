import Foundation

struct EngagementAggregator: Sendable {
	private struct ReadingSession: Sendable {
		let startedAt: Date
		var activeSince: Date?
		var unreportedActiveDuration: TimeInterval
		var maximumScrollDepth: Double
	}

	private var sessions: [String: ReadingSession] = [:]

	mutating func resume(itemId: String, at date: Date) -> Bool {
		if var session = sessions[itemId] {
			guard session.activeSince == nil else {
				return false
			}
			session.activeSince = date
			sessions[itemId] = session
			return true
		}
		sessions[itemId] = ReadingSession(
			startedAt: date,
			activeSince: date,
			unreportedActiveDuration: 0,
			maximumScrollDepth: 0
		)
		return true
	}

	mutating func pause(itemId: String, at date: Date) {
		guard var session = sessions[itemId], let activeSince = session.activeSince else {
			return
		}
		session.unreportedActiveDuration += max(0, date.timeIntervalSince(activeSince))
		session.activeSince = nil
		sessions[itemId] = session
	}

	mutating func updateScrollDepth(itemId: String, depth: Double) -> Int? {
		guard var session = sessions[itemId] else {
			return nil
		}
		session.maximumScrollDepth = max(session.maximumScrollDepth, min(max(depth, 0), 1))
		sessions[itemId] = session
		let threshold = Int((session.maximumScrollDepth * 4).rounded(.down))
		return threshold > 0 ? threshold : nil
	}

	mutating func activeReadingDeltaEvent(itemId: String, at date: Date, minimumDuration: TimeInterval = 10) -> EngagementEvent? {
		guard var session = sessions[itemId] else {
			return nil
		}
		let currentInterval = session.activeSince.map { max(0, date.timeIntervalSince($0)) } ?? 0
		let duration = session.unreportedActiveDuration + currentInterval
		guard duration >= minimumDuration else {
			return nil
		}
		session.unreportedActiveDuration = 0
		if session.activeSince != nil {
			session.activeSince = date
		}
		sessions[itemId] = session
		return EngagementEvent(
			itemId: itemId,
			type: .activeReading,
			durationSeconds: duration,
			scrollDepth: session.maximumScrollDepth,
			occurredAt: date,
		)
	}

	mutating func finish(itemId: String) -> ReadingSessionSummary? {
		guard let session = sessions.removeValue(forKey: itemId) else {
			return nil
		}
		return ReadingSessionSummary(startedAt: session.startedAt, maximumScrollDepth: session.maximumScrollDepth)
	}
}

struct ReadingSessionSummary: Equatable, Sendable {
	let startedAt: Date
	let maximumScrollDepth: Double
}
