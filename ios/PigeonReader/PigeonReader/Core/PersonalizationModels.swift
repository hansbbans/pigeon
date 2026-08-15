import Foundation

nonisolated struct PersonalizationSnapshot: Codable, Equatable, Sendable {
	let exportedAt: Date
	let policy: PersonalizationPolicy
	let history: [PersonalizationHistoryEntry]
}

nonisolated struct PersonalizationPolicy: Codable, Equatable, Sendable {
	let plainLanguageSummary: String
	let confirmedSignals: [PersonalizationSignal]
	let confirmationRule: String
	let retention: String
}

nonisolated struct PersonalizationSignal: Codable, Equatable, Identifiable, Sendable {
	let name: String
	let effect: String

	var id: String { name }
}

nonisolated struct PersonalizationHistoryEntry: Codable, Equatable, Identifiable, Sendable {
	let id: String
	let itemId: String
	let type: String
	let feedKey: String?
	let occurredAt: Date
	let title: String?
	let source: String?

	var eventTitle: String {
		switch type {
		case "more_like_this": "More like this"
		case "not_interested": "Not interested"
		case "explicit_open": "Opened story"
		case "active_reading": "Active reading"
		case "scroll_depth": "Reading progress"
		case "outbound_link": "Continued to source"
		case "star": "Starred"
		case "unstar": "Unstarred"
		case "read": "Marked read"
		case "unread": "Marked unread"
		default: type.replacingOccurrences(of: "_", with: " ").capitalized
		}
	}
}
