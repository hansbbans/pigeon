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

	private enum CodingKeys: String, CodingKey {
		case id
		case title
		case categories
		case url
		case iconURL = "iconUrl"
	}

	init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		id = try container.decode(String.self, forKey: .id)
		title = try container.decode(String.self, forKey: .title)
		categories = try container.decodeIfPresent([ReaderSubscriptionCategory].self, forKey: .categories) ?? []
		url = try container.decodeIfPresent(String.self, forKey: .url)
		iconURL = try container.decodeIfPresent(String.self, forKey: .iconURL)
	}

	init(
		id: String,
		title: String,
		categories: [ReaderSubscriptionCategory] = [],
		url: String? = nil,
		iconURL: String? = nil,
	) {
		self.id = id
		self.title = title
		self.categories = categories
		self.url = url
		self.iconURL = iconURL
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
}

nonisolated struct ReaderNavigationSnapshot: Sendable {
	let subscriptions: [ReaderSubscription]
	let unreadCounts: [ReaderUnreadCount]
	let starredUnreadCount: Int?
	let todayUnreadCount: Int?
}
