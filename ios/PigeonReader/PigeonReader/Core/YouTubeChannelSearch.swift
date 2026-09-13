import Foundation

nonisolated enum YouTubeChannelSearchMode: String, Codable, Equatable, Sendable {
	case search
	case handle
}

nonisolated struct YouTubeChannelSearchResult: Codable, Equatable, Hashable, Identifiable, Sendable {
	let id: String
	let title: String
	let description: String
	let channelURL: String
	let feedURL: String
	let thumbnailURL: String?

	enum CodingKeys: String, CodingKey {
		case id
		case title
		case description
		case channelURL = "channelUrl"
		case feedURL = "feedUrl"
		case thumbnailURL = "thumbnailUrl"
	}

	var channelLabel: String {
		guard let url = URL(string: channelURL), let firstPathComponent = url.path.split(separator: "/").first else {
			return channelURL
		}
		return firstPathComponent.hasPrefix("@") ? String(firstPathComponent) : channelURL
	}

	var validFeedURL: URL? {
		YouTubeChannelSearchInput.httpURL(from: feedURL, rejectingCredentials: true)
	}
}

nonisolated struct YouTubeChannelSearchResponse: Codable, Equatable, Sendable {
	let channels: [YouTubeChannelSearchResult]
	let mode: YouTubeChannelSearchMode
	let message: String?
}

nonisolated struct YouTubeChannelSearchRequest: Equatable, Sendable {
	let query: String
	let revision: Int
}

nonisolated enum YouTubeChannelSearchInput {
	static func trimmed(_ input: String) -> String {
		input.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	static func httpURL(from input: String, rejectingCredentials: Bool = false) -> URL? {
		let trimmed = trimmed(input)
		guard let url = URL(string: trimmed),
			let scheme = url.scheme?.lowercased(),
			(scheme == "http" || scheme == "https"),
			let host = url.host,
			!host.isEmpty else {
			return nil
		}
		if rejectingCredentials, url.user != nil || url.password != nil {
			return nil
		}
		return url
	}

	static func searchQuery(from input: String, minimumLength: Int = 2) -> String? {
		let query = trimmed(input)
		guard query.count >= minimumLength, httpURL(from: query) == nil else {
			return nil
		}
		return query
	}
}

/// Transient state for Add Feed's channel search. The revision makes a response
/// applicable only to the exact input that started its request.
nonisolated struct YouTubeChannelSearchState: Equatable, Sendable {
	private(set) var query = ""
	private(set) var revision = 0
	private(set) var channels: [YouTubeChannelSearchResult] = []
	private(set) var selectedChannel: YouTubeChannelSearchResult?
	private(set) var message: String?
	private(set) var errorMessage: String?
	private(set) var isSearching = false
	private(set) var hasCompletedSearch = false

	var request: YouTubeChannelSearchRequest {
		YouTubeChannelSearchRequest(query: query, revision: revision)
	}

	mutating func updateInput(_ input: String) {
		query = YouTubeChannelSearchInput.trimmed(input)
		revision &+= 1
		clearResults()
	}

	mutating func retry() {
		revision &+= 1
		clearResults()
	}

	func accepts(_ request: YouTubeChannelSearchRequest) -> Bool {
		self.request == request
	}

	mutating func beginSearch(for request: YouTubeChannelSearchRequest) -> Bool {
		guard accepts(request) else { return false }
		isSearching = true
		errorMessage = nil
		return true
	}

	@discardableResult
	mutating func apply(
		_ response: YouTubeChannelSearchResponse,
		for request: YouTubeChannelSearchRequest,
	) -> Bool {
		guard accepts(request) else { return false }
		channels = response.channels
		selectedChannel = nil
		message = response.message
		errorMessage = nil
		isSearching = false
		hasCompletedSearch = true
		return true
	}

	@discardableResult
	mutating func fail(_ errorMessage: String, for request: YouTubeChannelSearchRequest) -> Bool {
		guard accepts(request) else { return false }
		channels = []
		selectedChannel = nil
		message = nil
		self.errorMessage = errorMessage
		isSearching = false
		hasCompletedSearch = true
		return true
	}

	mutating func select(_ channel: YouTubeChannelSearchResult) {
		guard channels.contains(channel) else { return }
		selectedChannel = channel
	}

	private mutating func clearResults() {
		channels = []
		selectedChannel = nil
		message = nil
		errorMessage = nil
		isSearching = false
		hasCompletedSearch = false
	}
}
