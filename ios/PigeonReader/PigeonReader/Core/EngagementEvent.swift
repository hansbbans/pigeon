import Foundation

enum EngagementEventType: String, Codable, Sendable {
	case explicitOpen = "explicit_open"
	case activeReading = "active_reading"
	case scrollDepth = "scroll_depth"
	case outboundLink = "outbound_link"
	case moreLikeThis = "more_like_this"
	case notInterested = "not_interested"
}

struct EngagementEvent: Codable, Equatable, Identifiable, Sendable {
	let id: String
	let itemId: String
	let type: EngagementEventType
	let value: Double?
	let durationSeconds: Double?
	let scrollDepth: Double?
	let destinationHost: String?
	let occurredAt: Date

	init(
		id: String = UUID().uuidString,
		itemId: String,
		type: EngagementEventType,
		value: Double? = nil,
		durationSeconds: Double? = nil,
		scrollDepth: Double? = nil,
		destinationHost: String? = nil,
		occurredAt: Date = .now
	) {
		self.id = id
		self.itemId = itemId
		self.type = type
		self.value = value
		self.durationSeconds = durationSeconds
		self.scrollDepth = scrollDepth
		self.destinationHost = destinationHost
		self.occurredAt = occurredAt
	}
}
