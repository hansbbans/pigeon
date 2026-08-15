import Foundation

nonisolated enum ReaderNavigationKind: String, Codable, Hashable, Sendable {
	case smart
	case folder
	case feed
}

nonisolated struct ReaderNavigationItem: Codable, Hashable, Identifiable, Sendable {
	let id: String
	let title: String
	let streamID: String
	let kind: ReaderNavigationKind
	let unreadCount: Int
	let parentID: String?
	let feedKey: String?
	let iconURL: URL?
	let smartSection: ReaderSection?

	var isFolder: Bool {
		kind == .folder
	}

	var isFeed: Bool {
		kind == .feed
	}

	static func smart(_ section: ReaderSection, unreadCount: Int = 0) -> Self {
		Self(
			id: section.rawValue,
			title: section.title,
			streamID: section == .starred ? "user/-/state/com.google/starred" : "user/-/state/com.google/reading-list",
			kind: .smart,
			unreadCount: max(unreadCount, 0),
			parentID: nil,
			feedKey: nil,
			iconURL: nil,
			smartSection: section,
		)
	}
}
