import Foundation

nonisolated enum ReadingLogEventType: String, Codable, Sendable {
	case impression
}

/// One row of the reading log (`POST api/v1/reading-log`): what a list showed.
/// `id` is the idempotency key, so a resent batch is not counted twice.
nonisolated struct ReadingLogEvent: Codable, Equatable, Identifiable, Sendable {
	let id: String
	let itemId: String
	let type: ReadingLogEventType
	/// `for-you`, `unread`, `today`, `starred`, `saved`, `feed`, `folder` or `search`.
	let view: String
	/// 0-based rank in the list as displayed.
	let position: Int
	/// One per continuous showing of one list context.
	let sessionId: String
	let occurredAt: Date
	let metadata: ReadingLogMetadata?

	init(
		id: String = UUID().uuidString.lowercased(),
		itemId: String,
		type: ReadingLogEventType = .impression,
		view: String,
		position: Int,
		sessionId: String,
		occurredAt: Date,
		metadata: ReadingLogMetadata? = nil,
	) {
		self.id = id
		self.itemId = itemId
		self.type = type
		self.view = view
		self.position = position
		self.sessionId = sessionId
		self.occurredAt = occurredAt
		self.metadata = metadata
	}
}

/// Keys that do not apply are left out of the request.
nonisolated struct ReadingLogMetadata: Codable, Equatable, Sendable {
	/// The recommendation score of a For You row.
	var score: Int? = nil
	/// The stream id of a feed or folder list.
	var stream: String? = nil

	var isEmpty: Bool { score == nil && stream == nil }
}

/// Which list an impression came from, in the reading log's terms.
nonisolated struct ReadingLogList: Equatable, Sendable {
	let view: String
	let stream: String?

	static let searchView = "search"

	/// Search results are logged as `search` whatever collection they were
	/// opened from. The stream is kept for a feed or folder, and for a search
	/// limited to one.
	static func list(for collection: ReaderNavigationItem, search: ReaderSearchScope? = nil) -> Self {
		let view: String
		let stream: String?
		switch collection.kind {
		case .smart:
			view = collection.smartSection?.apiValue ?? ReaderSection.unread.apiValue
			stream = nil
		case .feed:
			view = "feed"
			stream = collection.streamID
		case .folder:
			view = "folder"
			stream = collection.streamID
		}
		guard let search else { return Self(view: view, stream: stream) }
		return Self(view: searchView, stream: search == .collection ? stream : nil)
	}
}
