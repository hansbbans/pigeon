import Foundation

nonisolated struct FeedCategory: Codable, Equatable, Hashable, Sendable {
	let id: String
	let label: String
}

nonisolated struct FeedSubscription: Codable, Equatable, Hashable, Identifiable, Sendable {
	let id: String
	var title: String
	var categories: [FeedCategory]
	let url: URL
	let sourceUrl: URL?
	let htmlUrl: URL?
	let iconUrl: String?

	init(
		id: String,
		title: String,
		categories: [FeedCategory],
		url: URL,
		sourceUrl: URL? = nil,
		htmlUrl: URL?,
		iconUrl: String?
	) {
		self.id = id
		self.title = title
		self.categories = categories
		self.url = url
		self.sourceUrl = sourceUrl
		self.htmlUrl = htmlUrl
		self.iconUrl = iconUrl
	}

	var feedKey: String {
		url.lastPathComponent
	}

	var folderNames: [String] {
		categories.map(\.label).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
	}
}

nonisolated struct FeedFolder: Equatable, Hashable, Identifiable, Sendable {
	let name: String
	let subscriptions: [FeedSubscription]

	var id: String { name }
}

nonisolated struct SubscriptionListResponse: Codable, Sendable {
	let subscriptions: [FeedSubscription]
}

nonisolated struct QuickAddResponse: Codable, Sendable {
	let query: String
	let numResults: Int
	let streamId: String
	let streamName: String
	let isNew: Bool?

	init(query: String, numResults: Int, streamId: String, streamName: String, isNew: Bool? = nil) {
		self.query = query
		self.numResults = numResults
		self.streamId = streamId
		self.streamName = streamName
		self.isNew = isNew
	}
}
