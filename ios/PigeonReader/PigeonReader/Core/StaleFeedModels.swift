import Foundation

nonisolated struct StaleFeedSnapshot: Codable, Equatable, Sendable {
	let cutoff: Date
	let feeds: [StaleFeed]
}

nonisolated struct StaleFeed: Codable, Equatable, Identifiable, Sendable {
	let feedKey: String
	let streamId: String
	let title: String
	let sourceType: String
	let sourceURL: URL?
	let siteURL: URL?
	let lastArticleAt: Date?
	let lastSuccessAt: Date?
	let httpStatus: Int?
	let archived: Bool

	var id: String { feedKey }
}

nonisolated enum StaleFeedArchiveAction: String, Codable, Sendable {
	case archive
	case unarchive
}

nonisolated struct StaleFeedArchiveRequest: Codable, Sendable {
	let action: StaleFeedArchiveAction
	let feedKeys: [String]
}
