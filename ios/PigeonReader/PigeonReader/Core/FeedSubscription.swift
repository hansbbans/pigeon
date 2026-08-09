import Foundation

struct FeedCategory: Codable, Equatable, Hashable, Sendable {
	let id: String
	let label: String
}

struct FeedSubscription: Codable, Equatable, Hashable, Identifiable, Sendable {
	let id: String
	var title: String
	var categories: [FeedCategory]
	let url: URL
	let htmlUrl: URL?
	let iconUrl: String?

	var feedKey: String {
		url.lastPathComponent
	}

	var folderNames: [String] {
		categories.map(\.label).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
	}
}

struct FeedFolder: Equatable, Hashable, Identifiable, Sendable {
	let name: String
	let subscriptions: [FeedSubscription]

	var id: String { name }
}

struct SubscriptionListResponse: Codable, Sendable {
	let subscriptions: [FeedSubscription]
}

struct QuickAddResponse: Codable, Sendable {
	let query: String
	let numResults: Int
	let streamId: String
	let streamName: String
}
