import Foundation

/// A small, synchronous snapshot for a feed's native context-menu preview.
/// `nil` means the collection has never been cached; an empty array means the
/// collection is cached and currently contains no stories.
nonisolated struct ReaderSidebarFeedPreviewData: Equatable, Sendable {
	nonisolated enum CacheState: Equatable, Sendable {
		case uncached
		case empty
		case loaded([Headline])
	}

	nonisolated struct Headline: Equatable, Identifiable, Sendable {
		let id: String
		let title: String
	}

	let title: String
	let unreadCount: Int
	let cacheState: CacheState

	static func make(
		feed: ReaderNavigationItem,
		cachedArticles: [Recommendation]?,
		limit: Int = 3,
	) -> Self {
		let cacheState: CacheState
		if let cachedArticles {
			let boundedLimit = max(0, limit)
			if cachedArticles.isEmpty || boundedLimit == 0 {
				cacheState = .empty
			} else {
				cacheState = .loaded(
					cachedArticles.prefix(boundedLimit).map { article in
						Headline(
							id: article.id,
							title: normalizedHeadlineTitle(article.title),
						)
					},
				)
			}
		} else {
			cacheState = .uncached
		}

		return Self(
			title: feed.title,
			unreadCount: max(feed.unreadCount, 0),
			cacheState: cacheState,
		)
	}

	private static func normalizedHeadlineTitle(_ title: String) -> String {
		let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
		return normalized.isEmpty ? "Untitled story" : normalized
	}
}
