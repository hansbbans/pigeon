import Foundation

nonisolated enum ReaderFeedPrewarmPolicy {
	static let maximumFeedCount = 2
	static let firstScreenPageLimit = 12
}

/// Chooses the small, visible slice that can be fetched after a folder opens.
/// The caller owns cancellation and cache/in-flight checks; this helper only
/// preserves sidebar order and the bounded scope of speculative work.
nonisolated enum ReaderFeedPrewarmPlanner {
	static func feeds(
		in folder: ReaderNavigationItem,
		visibleFeeds: [ReaderNavigationItem],
		limit: Int = ReaderFeedPrewarmPolicy.maximumFeedCount,
	) -> [ReaderNavigationItem] {
		guard folder.kind == .folder else { return [] }
		let boundedLimit = max(0, limit)
		guard boundedLimit > 0 else { return [] }

		var seenIDs = Set<String>()
		return visibleFeeds.filter { feed in
			feed.kind == .feed
				&& feed.parentID == folder.id
				&& seenIDs.insert(feed.id).inserted
		}.prefix(boundedLimit).map { $0 }
	}
}
