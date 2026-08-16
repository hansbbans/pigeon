import Foundation

nonisolated enum PigeonSharedData {
	static let appGroup = "group.com.hans.pigeon.reader"
	static let widgetSnapshotKey = "pigeon.widget.snapshot.v1"
	static let pendingFeedURLKey = "pigeon.pending-feed-url.v1"

	static var defaults: UserDefaults {
		UserDefaults(suiteName: appGroup) ?? .standard
	}
}

nonisolated struct PigeonWidgetArticle: Codable, Equatable, Identifiable, Sendable {
	let id: String
	let title: String
	let source: String
	let receivedAt: Date
	let deepLink: URL
}

nonisolated struct PigeonWidgetSnapshot: Codable, Equatable, Sendable {
	let generatedAt: Date
	let unreadCount: Int
	let starredCount: Int
	let recent: [PigeonWidgetArticle]
	let forYou: [PigeonWidgetArticle]

	static let empty = Self(generatedAt: .distantPast, unreadCount: 0, starredCount: 0, recent: [], forYou: [])

	static func load() -> Self {
		guard let data = PigeonSharedData.defaults.data(forKey: PigeonSharedData.widgetSnapshotKey),
			let value = try? JSONDecoder().decode(Self.self, from: data) else { return .empty }
		return value
	}

	func save() {
		guard let data = try? JSONEncoder().encode(self) else { return }
		PigeonSharedData.defaults.set(data, forKey: PigeonSharedData.widgetSnapshotKey)
	}
}

nonisolated enum PendingFeedStore {
	static func save(_ url: URL) {
		guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host != nil else { return }
		PigeonSharedData.defaults.set(url.absoluteString, forKey: PigeonSharedData.pendingFeedURLKey)
	}

	static func consume() -> URL? {
		let defaults = PigeonSharedData.defaults
		guard let raw = defaults.string(forKey: PigeonSharedData.pendingFeedURLKey) else { return nil }
		defaults.removeObject(forKey: PigeonSharedData.pendingFeedURLKey)
		return URL(string: raw)
	}
}
