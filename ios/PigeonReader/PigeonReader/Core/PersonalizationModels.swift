import Foundation

nonisolated struct PersonalizationSnapshot: Codable, Equatable, Sendable {
	let exportedAt: Date
	let policy: PersonalizationPolicy
	let history: [PersonalizationHistoryEntry]
	let monitoredTopics: [String]

	private enum CodingKeys: String, CodingKey {
		case exportedAt
		case policy
		case history
		case monitoredTopics
	}

	init(
		exportedAt: Date,
		policy: PersonalizationPolicy,
		history: [PersonalizationHistoryEntry],
		monitoredTopics: [String] = [],
	) {
		self.exportedAt = exportedAt
		self.policy = policy
		self.history = history
		self.monitoredTopics = PersonalizationTopicRules.normalized(monitoredTopics)
	}

	init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		exportedAt = try container.decode(Date.self, forKey: .exportedAt)
		policy = try container.decode(PersonalizationPolicy.self, forKey: .policy)
		history = try container.decode([PersonalizationHistoryEntry].self, forKey: .history)
		// Older servers predate topic preferences. Treat an omitted field as an
		// empty list so the rest of the personalization screen remains usable.
		monitoredTopics = PersonalizationTopicRules.normalized(
			try container.decodeIfPresent([String].self, forKey: .monitoredTopics) ?? []
		)
	}

	func encode(to encoder: Encoder) throws {
		var container = encoder.container(keyedBy: CodingKeys.self)
		try container.encode(exportedAt, forKey: .exportedAt)
		try container.encode(policy, forKey: .policy)
		try container.encode(history, forKey: .history)
		try container.encode(monitoredTopics, forKey: .monitoredTopics)
	}
}

nonisolated enum PersonalizationTopicRules {
	static let maximumTopicCount = 20
	static let minimumTopicLength = 2
	static let maximumTopicLength = 80

	static func normalizedTopic(_ value: String) -> String? {
		let normalized = value.precomposedStringWithCompatibilityMapping
			.split(whereSeparator: { $0.isWhitespace })
			.joined(separator: " ")
		guard normalized.count >= minimumTopicLength,
			normalized.count <= maximumTopicLength,
			normalized.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) else {
			return nil
		}
		return normalized
	}

	static func normalized(_ values: [String]) -> [String] {
		var seen = Set<String>()
		return values.compactMap { value in
			guard let topic = normalizedTopic(value) else { return nil }
			let key = topic.lowercased()
			guard seen.insert(key).inserted else { return nil }
			return topic
		}
	}

	static func validated(_ values: [String]) throws -> [String] {
		guard values.count <= maximumTopicCount else {
			throw PersonalizationTopicValidationError.tooMany
		}

		var seen = Set<String>()
		var result: [String] = []
		result.reserveCapacity(values.count)
		for value in values {
			guard let topic = normalizedTopic(value) else {
				throw PersonalizationTopicValidationError.invalidLength
			}
			let key = topic.lowercased()
			guard seen.insert(key).inserted else { continue }
			result.append(topic)
		}
		return result
	}
}

nonisolated enum PersonalizationTopicValidationError: Error, LocalizedError, Equatable, Sendable {
	case invalidLength
	case duplicate
	case tooMany

	var errorDescription: String? {
		switch self {
		case .invalidLength:
			"Topics must be 2 to 80 characters after spaces are collapsed and include a letter or number."
		case .duplicate:
			"Each topic can appear only once."
		case .tooMany:
			"You can monitor up to 20 topics."
		}
	}
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
