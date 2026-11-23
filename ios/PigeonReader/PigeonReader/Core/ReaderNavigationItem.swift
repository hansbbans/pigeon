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

	/// Folder rows use their label's stream ID, `user/-/label/<name>`, as the
	/// Pigeon server and every local folder edit spell it. Usable where only a
	/// collection ID is at hand (restoration, cached snapshot preparation).
	static func isFolderID(_ id: String) -> Bool {
		id.hasPrefix("user/-/label/")
	}

	static func smart(_ section: ReaderSection, unreadCount: Int = 0, streamID savedStreamID: String? = nil) -> Self {
		let streamID: String = switch section {
		case .starred: "user/-/state/com.google/starred"
		// The saved feed's `feed/<rowid>`; Read It Later itself is sync-backed.
		case .saved: savedStreamID ?? SavedItems.feedKey
		case .forYou, .unread, .today, .lastSevenDays: "user/-/state/com.google/reading-list"
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

	/// The same row with another unread count.
	func replacingUnreadCount(_ count: Int) -> Self {
		Self(
			id: id,
			title: title,
			streamID: streamID,
			kind: kind,
			unreadCount: count,
			parentID: parentID,
			feedKey: feedKey,
			iconURL: iconURL,
			smartSection: smartSection,
		)
	}
}
