import Foundation

/// Which feed a story belongs to, for By Feed order and folder sections.
/// Stream pages key stories on `feed/<rowid>` and sync changes on the plain
/// feed key, so both spellings resolve through the sidebar's feed rows to one
/// feed with the title the sidebar shows.
nonisolated struct ArticleFeedDirectory: Equatable, Sendable {
	nonisolated struct Feed: Equatable, Hashable, Sendable {
		/// The feed's stream ID (`feed/<rowid>`) when known, else the story's key.
		let id: String
		let title: String
		let iconURL: URL?
	}

	static let empty = Self(feedsByKey: [:])

	private let feedsByKey: [String: Feed]

	private init(feedsByKey: [String: Feed]) {
		self.feedsByKey = feedsByKey
	}

	init(navigationItems: [ReaderNavigationItem]) {
		var feeds: [String: Feed] = [:]
		// A feed in several folders has one row per folder, all alike.
		for item in navigationItems where item.kind == .feed {
			let feed = Feed(id: item.streamID, title: item.title, iconURL: item.iconURL)
			feeds[item.streamID] = feed
			if let feedKey = item.feedKey, feedKey.isEmpty == false {
				feeds[feedKey] = feed
			}
		}
		self.init(feedsByKey: feeds)
	}

	/// Stories from feeds the sidebar does not list fall back to their own key
	/// and source name.
	func feed(for article: Recommendation) -> Feed {
		feedsByKey[article.feedKey] ?? Feed(id: article.feedKey, title: article.source, iconURL: nil)
	}
}
