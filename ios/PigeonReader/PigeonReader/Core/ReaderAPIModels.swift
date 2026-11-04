import Foundation

nonisolated struct ReaderSubscriptionListResponse: Decodable, Sendable {
	let subscriptions: [ReaderSubscription]
}

nonisolated struct ReaderSubscription: Decodable, Sendable {
	let id: String
	let title: String
	let categories: [ReaderSubscriptionCategory]
	let url: String?
	let iconURL: String?
	/// "email", "rss" or "saved"; absent on older servers.
	let sourceType: String?

	private enum CodingKeys: String, CodingKey {
		case id
		case title
		case categories
		case url
		case iconURL = "iconUrl"
		case sourceType
	}

	init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		id = try container.decode(String.self, forKey: .id)
		title = try container.decode(String.self, forKey: .title)
		categories = try container.decodeIfPresent([ReaderSubscriptionCategory].self, forKey: .categories) ?? []
		url = try container.decodeIfPresent(String.self, forKey: .url)
		iconURL = try container.decodeIfPresent(String.self, forKey: .iconURL)
		sourceType = try? container.decodeIfPresent(String.self, forKey: .sourceType)
	}

	init(
		id: String,
		title: String,
		categories: [ReaderSubscriptionCategory] = [],
		url: String? = nil,
		iconURL: String? = nil,
		sourceType: String? = nil,
	) {
		self.id = id
		self.title = title
		self.categories = categories
		self.url = url
		self.iconURL = iconURL
		self.sourceType = sourceType
	}

	/// The Read It Later system feed. Its URL ends in `/feed/pigeon:saved`, so
	/// it is recognised even where the source type is missing.
	var isSavedFeed: Bool {
		guard sourceType != SavedItems.sourceType else { return true }
		guard let url, let parsed = URL(string: url) else { return false }
		return parsed.lastPathComponent == SavedItems.feedKey
	}
}

nonisolated struct ReaderSubscriptionCategory: Decodable, Sendable, Hashable {
	let id: String
	let label: String?
}

nonisolated struct ReaderUnreadCountResponse: Decodable, Sendable {
	let unreadCounts: [ReaderUnreadCount]

	private enum CodingKeys: String, CodingKey {
		case unreadCounts = "unreadcounts"
	}
}

nonisolated struct ReaderUnreadCount: Decodable, Sendable, Hashable {
	let id: String
	let count: Int
}

nonisolated struct ReaderStreamContentsResponse: Decodable, Sendable {
	let id: String
	let items: [ReaderStreamItem]
	let continuation: String?
}

nonisolated struct ReaderStreamItemIDsResponse: Decodable, Sendable {
	let itemRefs: [ReaderStreamItemReference]
	let continuation: String?
}

nonisolated struct ReaderStreamItemReference: Decodable, Sendable {
	let id: String
	// Pigeon extensions; absent on plain Google Reader servers.
	var timestampUsec: String? = nil
	var read: Bool? = nil
	var starred: Bool? = nil
	var contentVersion: String? = nil
}

nonisolated struct ReaderStreamItem: Decodable, Sendable, Hashable {
	let id: String
	let categories: [String]
	let title: String
	let author: String?
	let published: Int
	let summary: ReaderStreamContent?
	let content: ReaderStreamContent?
	let alternate: [ReaderAlternateLink]
	let origin: ReaderStreamOrigin?
	let isBodyPruned: Bool?
	let contentVersion: String?
	let isPaywalled: Bool?
	let length: ArticleLength?
	let savedMetadata: SavedArticleMetadata?
	let hasTranscript: Bool?

	private enum CodingKeys: String, CodingKey {
		case id
		case categories
		case title
		case author
		case published
		case summary
		case content
		case alternate
		case origin
		case isBodyPruned
		case contentVersion
		case isPaywalled
		case wordCount
		case mediaKind
		case durationSeconds
		case extractionState
		case publishedAt
		case imageURL = "imageUrl"
		case siteName
		case hasTranscript
	}

	init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		id = try container.decode(String.self, forKey: .id)
		categories = try container.decodeIfPresent([String].self, forKey: .categories) ?? []
		title = try container.decodeIfPresent(String.self, forKey: .title) ?? "Untitled"
		author = Self.normalizedAuthor(try container.decodeIfPresent(String.self, forKey: .author))
		published = try container.decodeIfPresent(Int.self, forKey: .published) ?? 0
		summary = try container.decodeIfPresent(ReaderStreamContent.self, forKey: .summary)
		content = try container.decodeIfPresent(ReaderStreamContent.self, forKey: .content)
		alternate = try container.decodeIfPresent([ReaderAlternateLink].self, forKey: .alternate) ?? []
		origin = try container.decodeIfPresent(ReaderStreamOrigin.self, forKey: .origin)
		isBodyPruned = try container.decodeIfPresent(Bool.self, forKey: .isBodyPruned)
		contentVersion = try container.decodeIfPresent(String.self, forKey: .contentVersion)
		isPaywalled = try container.decodeIfPresent(Bool.self, forKey: .isPaywalled)
		length = ArticleLength(
			wordCount: try? container.decodeIfPresent(Int.self, forKey: .wordCount),
			mediaKind: try? container.decodeIfPresent(String.self, forKey: .mediaKind),
			durationSeconds: try? container.decodeIfPresent(Int.self, forKey: .durationSeconds)
		)
		savedMetadata = SavedArticleMetadata(
			extractionState: try? container.decodeIfPresent(String.self, forKey: .extractionState),
			publishedAt: (try? container.decodeIfPresent(String.self, forKey: .publishedAt)).flatMap { $0 }
				.flatMap(SavedArticleMetadata.parseDate),
			imageURL: (try? container.decodeIfPresent(String.self, forKey: .imageURL)).flatMap { $0 }
				.flatMap(URL.init(string:)),
			siteName: try? container.decodeIfPresent(String.self, forKey: .siteName),
		)
		hasTranscript = (try? container.decodeIfPresent(Bool.self, forKey: .hasTranscript)) ?? nil
	}

	var isRead: Bool {
		categories.contains("user/-/state/com.google/read")
	}

	var isStarred: Bool {
		categories.contains("user/-/state/com.google/starred")
	}

	private static func normalizedAuthor(_ value: String?) -> String? {
		Recommendation.displayAuthor(value, source: "")
	}
}

nonisolated struct ReaderStreamContent: Decodable, Sendable, Hashable {
	let content: String
}

nonisolated struct ReaderAlternateLink: Decodable, Sendable, Hashable {
	let href: String
}

nonisolated struct ReaderStreamOrigin: Decodable, Sendable, Hashable {
	let streamID: String
	let title: String
	let htmlURL: String?

	private enum CodingKeys: String, CodingKey {
		case streamID = "streamId"
		case title
		case htmlURL = "htmlUrl"
	}
}

nonisolated struct ReaderNavigationSmartCounts: Equatable, Sendable {
	let forYou: Int
	let today: Int
	let unread: Int
	let starred: Int
	/// Unread Read It Later items; nil lets the catalog read the saved feed's count.
	var saved: Int? = nil
}

nonisolated struct ReaderNavigationSnapshot: Sendable {
	let subscriptions: [ReaderSubscription]
	let unreadCounts: [ReaderUnreadCount]
	let starredUnreadCount: Int?
	/// Requested with `xs=saved`, so Read It Later is already left out.
	let todayUnreadCount: Int?

	var savedSubscription: ReaderSubscription? {
		subscriptions.first(where: \.isSavedFeed)
	}

	var savedUnreadCount: Int {
		guard let savedSubscription else { return 0 }
		return unreadCounts.first(where: { $0.id == savedSubscription.id })?.count ?? 0
	}

	/// The reading-list total; `xs=saved` already leaves Read It Later out.
	var readingListUnreadCount: Int {
		unreadCounts.first(where: { $0.id == "user/-/state/com.google/reading-list" })?.count ?? 0
	}
}
