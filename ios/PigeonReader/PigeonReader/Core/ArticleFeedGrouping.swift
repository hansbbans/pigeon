import Foundation

/// Which feed a story belongs to, for By Feed order and its section labels.
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

/// One feed's run of stories in a list shown By Feed. The label is view-only:
/// every index, count and position still refers to the flat story list.
nonisolated struct ArticleFeedSection: Equatable, Identifiable, Sendable {
	let id: String
	let feed: ArticleFeedDirectory.Feed
	let articles: [Recommendation]

	/// Consecutive runs of one feed, in list order. A list held on screen while
	/// updates wait can show a feed twice; later runs get a numbered ID.
	static func sections(for articles: [Recommendation], feeds: ArticleFeedDirectory) -> [Self] {
		var sections: [Self] = []
		var runsByFeedID: [String: Int] = [:]
		var currentFeed: ArticleFeedDirectory.Feed?
		var currentArticles: [Recommendation] = []

		func closeRun() {
			guard let feed = currentFeed, currentArticles.isEmpty == false else { return }
			let run = runsByFeedID[feed.id, default: 0] + 1
			runsByFeedID[feed.id] = run
			sections.append(Self(id: run == 1 ? feed.id : "\(feed.id)#\(run)", feed: feed, articles: currentArticles))
		}

		for article in articles {
			let feed = feeds.feed(for: article)
			if feed.id != currentFeed?.id {
				closeRun()
				currentFeed = feed
				currentArticles = []
			}
			currentArticles.append(article)
		}
		closeRun()
		return sections
	}
}
