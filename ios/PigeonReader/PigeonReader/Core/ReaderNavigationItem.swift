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

	static func smart(_ section: ReaderSection, unreadCount: Int = 0, streamID savedStreamID: String? = nil) -> Self {
		let streamID: String = switch section {
		case .starred: "user/-/state/com.google/starred"
		// The saved feed's `feed/<rowid>`; Read It Later itself is sync-backed.
		case .saved: savedStreamID ?? SavedItems.feedKey
		case .forYou, .unread, .today: "user/-/state/com.google/reading-list"
		}
		return Self(
			id: section.rawValue,
			title: section.title,
			streamID: streamID,
			kind: .smart,
			unreadCount: max(unreadCount, 0),
			parentID: nil,
			feedKey: nil,
			iconURL: nil,
			smartSection: section,
		)
	}
}
