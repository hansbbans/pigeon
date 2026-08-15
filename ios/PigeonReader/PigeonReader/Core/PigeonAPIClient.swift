import Foundation

struct RecommendationsResponse: Codable, Sendable {
	let generatedAt: Date
	let view: String
	let items: [Recommendation]
}

struct PigeonAPIClient: Sendable {
	private static let streamItemIDPageLimit = 50
	private static let streamItemContentChunkSize = 20

	let session: PigeonSession
	private let httpClient: any HTTPClient

	init(session: PigeonSession, httpClient: any HTTPClient = URLSessionHTTPClient()) {
		self.session = session
		self.httpClient = httpClient
	}

	static func authenticate(
		baseURL: URL,
		password: String,
		httpClient: any HTTPClient = URLSessionHTTPClient()
	) async throws -> PigeonSession {
		let normalizedURL = try normalizeServerURL(baseURL)
		let request = makeClientLoginRequest(baseURL: normalizedURL, password: password)
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)

		let body = String(decoding: data, as: UTF8.self)
		guard let authLine = body.split(whereSeparator: \.isNewline).first(where: { $0.hasPrefix("Auth=") }) else {
			throw PigeonError.authenticationFailed
		}
		let rawToken = authLine.dropFirst("Auth=".count)
		guard rawToken.hasPrefix("pigeon/"), rawToken.count > "pigeon/".count else {
			throw PigeonError.authenticationFailed
		}
		return PigeonSession(baseURL: normalizedURL, token: String(rawToken.dropFirst("pigeon/".count)))
	}

	static func makeClientLoginRequest(baseURL: URL, password: String) -> URLRequest {
		let endpoint = baseURL.appending(path: "accounts/ClientLogin")
		var request = URLRequest(url: endpoint)
		request.httpMethod = "POST"
		request.setValue("application/x-www-form-urlencoded; charset=utf-8", forHTTPHeaderField: "Content-Type")
		var components = URLComponents()
		components.queryItems = [
			URLQueryItem(name: "Email", value: "pigeon"),
			URLQueryItem(name: "Passwd", value: password),
			URLQueryItem(name: "service", value: "reader"),
		]
		request.httpBody = components.percentEncodedQuery?.data(using: .utf8)
		return request
	}

	func recommendations(for section: ReaderSection, limit: Int = 30) async throws -> [Recommendation] {
		var components = try endpointComponents(path: "api/v1/recommendations")
		components.queryItems = [
			URLQueryItem(name: "view", value: section.apiValue),
			URLQueryItem(name: "limit", value: String(limit)),
		]
		var request = makeAuthorizedRequest(url: try endpointURL(components: components))
		request.httpMethod = "GET"
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
		return try decoder.decode(RecommendationsResponse.self, from: data).items
	}

	func syncHealth() async throws -> SyncHealthSnapshot {
		let (data, _) = try await requestJSON(path: "app/status")
		return try decoder.decode(ServerStatusResponse.self, from: data).syncHealth
	}

	func retryFeed(feedKey: String) async throws {
		var request = makeAuthorizedRequest(url: session.baseURL.appending(path: "app/status/retry"))
		request.httpMethod = "POST"
		request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONEncoder().encode(["feed_key": feedKey])
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
	}

	func incrementalSync(cursor: String?, limit: Int = 200) async throws -> IncrementalSyncPage {
		var components = try endpointComponents(path: "api/v1/sync")
		var queryItems = [URLQueryItem(name: "limit", value: String(min(max(limit, 1), 200)))]
		if let cursor, cursor.isEmpty == false {
			queryItems.append(URLQueryItem(name: "cursor", value: cursor))
		}
		components.queryItems = queryItems
		let (data, _) = try await requestJSON(components: components)
		return try decoder.decode(IncrementalSyncPage.self, from: data)
	}

	func sendMutations(_ mutations: [OfflineMutation]) async throws -> OfflineMutationBatchResponse {
		guard mutations.isEmpty == false else {
			return OfflineMutationBatchResponse(results: [])
		}
		var request = makeAuthorizedRequest(url: session.baseURL.appending(path: "api/v1/mutations"))
		request.httpMethod = "POST"
		request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
		request.setValue("pigeon-reader/1", forHTTPHeaderField: "X-Pigeon-Client")
		request.httpBody = try JSONEncoder().encode(OfflineMutationEnvelope(mutations: Array(mutations.prefix(100))))
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
		return try decoder.decode(OfflineMutationBatchResponse.self, from: data)
	}

	func navigationSnapshot(
		now: Date = .now,
		dayBounds: ReaderLocalDayBounds? = nil,
	) async throws -> ReaderNavigationSnapshot {
		let bounds = dayBounds ?? ReaderLocalDayBounds.localDay(containing: now)
		async let subscriptions = readerSubscriptions()
		async let unreadCounts = readerUnreadCounts()
		async let starredUnreadCount = unreadCountIfAvailable(in: "user/-/state/com.google/starred")
		async let todayUnreadCount = unreadCountIfAvailable(on: bounds)
		return try await ReaderNavigationSnapshot(
			subscriptions: subscriptions,
			unreadCounts: unreadCounts,
			starredUnreadCount: starredUnreadCount,
			todayUnreadCount: todayUnreadCount,
		)
	}

	func readerSubscriptions() async throws -> [ReaderSubscription] {
		let (data, _) = try await requestJSON(path: "reader/api/0/subscription/list")
		return try decoder.decode(ReaderSubscriptionListResponse.self, from: data).subscriptions
	}

	// Keep the feed-library API available to the existing management screens while the
	// reader sidebar uses the richer ReaderSubscription models above.
	func subscriptions() async throws -> [FeedSubscription] {
		var request = makeAuthorizedRequest(url: session.baseURL.appending(path: "reader/api/0/subscription/list"))
		request.httpMethod = "GET"
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
		return try decoder.decode(SubscriptionListResponse.self, from: data).subscriptions
	}

	@discardableResult
	func addSubscription(url: URL) async throws -> QuickAddResponse {
		var components = try endpointComponents(path: "reader/api/0/subscription/quickadd")
		components.queryItems = [URLQueryItem(name: "quickadd", value: url.absoluteString)]
		var request = makeAuthorizedRequest(url: try endpointURL(components: components))
		request.httpMethod = "GET"
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
		return try decoder.decode(QuickAddResponse.self, from: data)
	}

	func editSubscription(
		id: String,
		title: String? = nil,
		addingFolders: [String] = [],
		removingFolders: [String] = []
	) async throws {
		var queryItems = [
			URLQueryItem(name: "ac", value: "edit"),
			URLQueryItem(name: "s", value: id),
		]
		if let title {
			queryItems.append(URLQueryItem(name: "t", value: title))
		}
		queryItems.append(contentsOf: addingFolders.map {
			URLQueryItem(name: "a", value: "user/-/label/\($0)")
		})
		queryItems.append(contentsOf: removingFolders.map {
			URLQueryItem(name: "r", value: "user/-/label/\($0)")
		})
		try await sendSubscriptionEdit(queryItems)
	}

	func unsubscribe(id: String) async throws {
		try await sendSubscriptionEdit([
			URLQueryItem(name: "ac", value: "unsubscribe"),
			URLQueryItem(name: "s", value: id),
		])
	}

	func readerUnreadCounts() async throws -> [ReaderUnreadCount] {
		let (data, response) = try await requestJSON(path: "reader/api/0/unread-count")
		_ = response
		return try decoder.decode(ReaderUnreadCountResponse.self, from: data).unreadCounts
	}

	func streamContents(
		streamID: String,
		excludeTag: String? = nil,
		limit: Int = 1_000,
		continuation: String? = nil,
	) async throws -> ReaderStreamContentsResponse {
		var components = try endpointComponents(path: "reader/api/0/stream/contents")
		var queryItems = [
			URLQueryItem(name: "s", value: streamID),
			URLQueryItem(name: "n", value: String(min(max(limit, 1), 1_000))),
		]
		if let excludeTag {
			queryItems.append(URLQueryItem(name: "xt", value: excludeTag))
		}
		if let continuation {
			queryItems.append(URLQueryItem(name: "c", value: continuation))
		}
		components.queryItems = queryItems
		let (data, _) = try await requestJSON(components: components)
		return try decoder.decode(ReaderStreamContentsResponse.self, from: data)
	}

	func streamItemIDs(
		streamID: String,
		excludeTag: String? = nil,
		olderThanUnix: Int? = nil,
		limit: Int = 1_000,
		continuation: String? = nil,
	) async throws -> ReaderStreamItemIDsResponse {
		var components = try endpointComponents(path: "reader/api/0/stream/items/ids")
		var queryItems = [
			URLQueryItem(name: "s", value: streamID),
			URLQueryItem(name: "n", value: String(min(max(limit, 1), 1_000))),
		]
		if let excludeTag {
			queryItems.append(URLQueryItem(name: "xt", value: excludeTag))
		}
		if let olderThanUnix {
			queryItems.append(URLQueryItem(name: "ot", value: String(olderThanUnix)))
		}
		if let continuation {
			queryItems.append(URLQueryItem(name: "c", value: continuation))
		}
		components.queryItems = queryItems
		let (data, _) = try await requestJSON(components: components)
		return try decoder.decode(ReaderStreamItemIDsResponse.self, from: data)
	}

	private func streamItemContents(itemIDs: [String]) async throws -> ReaderStreamContentsResponse {
		var request = makeAuthorizedRequest(url: session.baseURL.appending(path: "reader/api/0/stream/items/contents"))
		request.httpMethod = "POST"
		request.setValue("application/x-www-form-urlencoded; charset=utf-8", forHTTPHeaderField: "Content-Type")
		var components = URLComponents()
		components.queryItems = itemIDs.map { URLQueryItem(name: "i", value: $0) }
		request.httpBody = components.percentEncodedQuery?.data(using: .utf8)
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
		return try decoder.decode(ReaderStreamContentsResponse.self, from: data)
	}

	func recommendations(from streamID: String, dayBounds: ReaderLocalDayBounds? = nil) async throws -> [Recommendation] {
		let items = try await streamItems(streamID: streamID, dayBounds: dayBounds)
		return items.map { recommendation(from: $0, fallbackStreamID: streamID) }
	}

	func unreadCount(in streamID: String) async throws -> Int {
		try await unreadItemCount(streamID: streamID)
	}

	func unreadCount(on dayBounds: ReaderLocalDayBounds) async throws -> Int {
		try await unreadItemCount(
			streamID: "user/-/state/com.google/reading-list",
			olderThanUnix: max(dayBounds.startSeconds - 1, 0),
		)
	}

	private func unreadItemCount(streamID: String, olderThanUnix: Int? = nil) async throws -> Int {
		var count = 0
		var continuation: String?
		var seenContinuations = Set<String>()

		while true {
			try Task.checkCancellation()
			let page = try await streamItemIDs(
				streamID: streamID,
				excludeTag: "user/-/state/com.google/read",
				olderThanUnix: olderThanUnix,
				continuation: continuation,
			)
			count += page.itemRefs.count
			guard let nextContinuation = page.continuation,
				seenContinuations.insert(nextContinuation).inserted else {
				return count
			}
			continuation = nextContinuation
		}
	}

	private func unreadCountIfAvailable(in streamID: String) async throws -> Int? {
		do {
			return try await unreadCount(in: streamID)
		} catch is CancellationError {
			throw CancellationError()
		} catch {
			return nil
		}
	}

	private func unreadCountIfAvailable(on dayBounds: ReaderLocalDayBounds) async throws -> Int? {
		do {
			return try await unreadCount(on: dayBounds)
		} catch is CancellationError {
			throw CancellationError()
		} catch {
			return nil
		}
	}

	func updateItemState(readerId: String, tag: String, enabled: Bool) async throws {
		var request = makeAuthorizedRequest(url: session.baseURL.appending(path: "reader/api/0/edit-tag"))
		request.httpMethod = "POST"
		request.setValue("application/x-www-form-urlencoded; charset=utf-8", forHTTPHeaderField: "Content-Type")
		let parameter = enabled ? "a" : "r"
		let tagQuery = URLQueryItem(name: parameter, value: tag)
		var components = URLComponents()
		components.queryItems = [URLQueryItem(name: "i", value: readerId), tagQuery]
		request.httpBody = components.percentEncodedQuery?.data(using: .utf8)
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
	}

	func sendEngagement(_ events: [EngagementEvent]) async throws {
		var request = makeAuthorizedRequest(url: session.baseURL.appending(path: "api/v1/engagement"))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("pigeon-reader/1", forHTTPHeaderField: "X-Pigeon-Client")
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .iso8601
		request.httpBody = try encoder.encode(EngagementEnvelope(events: events))
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
	}

	func personalization() async throws -> PersonalizationSnapshot {
		let (data, _) = try await requestJSON(path: "api/v1/personalization")
		return try decoder.decode(PersonalizationSnapshot.self, from: data)
	}

	func deletePersonalizationHistory(id: String) async throws {
		var components = try endpointComponents(path: "api/v1/personalization")
		components.queryItems = [URLQueryItem(name: "id", value: id)]
		var request = makeAuthorizedRequest(url: try endpointURL(components: components))
		request.httpMethod = "DELETE"
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
	}

	func resetPersonalization() async throws {
		var components = try endpointComponents(path: "api/v1/personalization")
		components.queryItems = [URLQueryItem(name: "all", value: "1")]
		var request = makeAuthorizedRequest(url: try endpointURL(components: components))
		request.httpMethod = "DELETE"
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
	}

	func exportPersonalization() async throws -> String {
		var components = try endpointComponents(path: "api/v1/personalization")
		components.queryItems = [URLQueryItem(name: "download", value: "1")]
		let (data, _) = try await requestJSON(components: components)
		return String(decoding: data, as: UTF8.self)
	}

	private func streamItems(
		streamID: String,
		excludeTag: String? = nil,
		dayBounds: ReaderLocalDayBounds? = nil,
	) async throws -> [ReaderStreamItem] {
		var items: [ReaderStreamItem] = []
		var continuation: String?
		var seenContinuations = Set<String>()
		var seenItemIDs = Set<String>()
		let olderThanUnix = dayBounds.map { max($0.startSeconds - 1, 0) }

		while true {
			try Task.checkCancellation()
			let page = try await streamItemIDs(
				streamID: streamID,
				excludeTag: excludeTag,
				olderThanUnix: olderThanUnix,
				limit: Self.streamItemIDPageLimit,
				continuation: continuation,
			)
			let newItemIDs = page.itemRefs.map(\.id).filter { itemID in
				seenItemIDs.insert(Self.normalizedItemID(itemID)).inserted
			}

			for startIndex in stride(from: 0, to: newItemIDs.count, by: Self.streamItemContentChunkSize) {
				try Task.checkCancellation()
				let endIndex = min(startIndex + Self.streamItemContentChunkSize, newItemIDs.count)
				let itemIDChunk = Array(newItemIDs[startIndex..<endIndex])
				let contentPage = try await streamItemContents(itemIDs: itemIDChunk)
				let itemsByID = Dictionary(
					contentPage.items.map { (Self.normalizedItemID($0.id), $0) },
					uniquingKeysWith: { first, _ in first },
				)

				for itemID in itemIDChunk {
					guard let item = itemsByID[Self.normalizedItemID(itemID)] else {
						continue
					}
					if let dayBounds {
						let date = Date(timeIntervalSince1970: TimeInterval(item.published))
						guard dayBounds.contains(date) else {
							continue
						}
					}
					items.append(item)
				}
			}

			if page.continuation == nil {
				return items
			}
			guard let nextContinuation = page.continuation, seenContinuations.insert(nextContinuation).inserted else {
				return items
			}
			continuation = nextContinuation
		}
	}

	private static func normalizedItemID(_ itemID: String) -> String {
		let prefix = "tag:google.com,2005:reader/item/"
		guard itemID.hasPrefix(prefix),
			let rowID = UInt64(String(itemID.dropFirst(prefix.count)), radix: 16) else {
			return itemID
		}
		return String(rowID)
	}

	private func recommendation(from item: ReaderStreamItem, fallbackStreamID: String) -> Recommendation {
		let source = item.origin?.title ?? "Pigeon"
		let html = item.content?.content ?? item.summary?.content ?? "<p>No article content available.</p>"
		return Recommendation(
			id: item.id,
			readerId: item.id,
			feedKey: item.origin?.streamID ?? fallbackStreamID,
			source: source,
			author: item.author,
			title: item.title,
			html: html,
			text: nil,
			originalURL: item.alternate.first.flatMap { URL(string: $0.href) },
			receivedAt: Date(timeIntervalSince1970: TimeInterval(item.published)),
			isRead: item.isRead,
			isStarred: item.isStarred,
			score: 0,
			confidence: 0,
			sampleCount: 0,
			explanation: "From \(source)",
			learningState: "Reader subscription",
		)
	}

	private func requestJSON(path: String) async throws -> (Data, URLResponse) {
		let components = try endpointComponents(path: path)
		return try await requestJSON(components: components)
	}

	private func requestJSON(components: URLComponents) async throws -> (Data, URLResponse) {
		let url = try endpointURL(components: components)
		var request = makeAuthorizedRequest(url: url)
		request.httpMethod = "GET"
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
		return (data, response)
	}

	private func sendSubscriptionEdit(_ queryItems: [URLQueryItem]) async throws {
		var request = makeAuthorizedRequest(url: session.baseURL.appending(path: "reader/api/0/subscription/edit"))
		request.httpMethod = "POST"
		request.setValue("application/x-www-form-urlencoded; charset=utf-8", forHTTPHeaderField: "Content-Type")
		var components = URLComponents()
		components.queryItems = queryItems
		request.httpBody = components.percentEncodedQuery?.data(using: .utf8)
		let (data, response) = try await httpClient.data(for: request)
		try Self.validate(response: response, data: data)
	}

	private var decoder: JSONDecoder {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .custom { decoder in
			let value = try decoder.singleValueContainer().decode(String.self)
			let fractionalFormatter = ISO8601DateFormatter()
			fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
			if let date = fractionalFormatter.date(from: value) {
				return date
			}
			let formatter = ISO8601DateFormatter()
			formatter.formatOptions = [.withInternetDateTime]
			guard let date = formatter.date(from: value) else {
				throw DecodingError.dataCorruptedError(
					in: try decoder.singleValueContainer(),
					debugDescription: "Expected an ISO 8601 date.",
				)
			}
			return date
		}
		return decoder
	}

	private func endpointComponents(path: String) throws -> URLComponents {
		guard let components = URLComponents(url: session.baseURL.appending(path: path), resolvingAgainstBaseURL: false) else {
			throw PigeonError.invalidServerURL
		}
		return components
	}

	private func endpointURL(components: URLComponents) throws -> URL {
		guard let url = components.url else {
			throw PigeonError.invalidServerURL
		}
		return url
	}

	private func makeAuthorizedRequest(url: URL) -> URLRequest {
		var request = URLRequest(url: url)
		request.setValue("GoogleLogin auth=pigeon/\(session.token)", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		return request
	}

	private static func normalizeServerURL(_ url: URL) throws -> URL {
		guard let scheme = url.scheme?.lowercased(), scheme == "https", url.host != nil else {
			throw PigeonError.invalidServerURL
		}
		var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
		components?.fragment = nil
		components?.query = nil
		let trimmedPath = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
		components?.path = trimmedPath.isEmpty ? "" : "/\(trimmedPath)"
		guard let normalized = components?.url else {
			throw PigeonError.invalidServerURL
		}
		return normalized
	}

	private static func validate(response: URLResponse, data: Data) throws {
		guard let httpResponse = response as? HTTPURLResponse else {
			throw PigeonError.invalidResponse
		}
		guard 200..<300 ~= httpResponse.statusCode else {
			let message = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
			if httpResponse.statusCode == 401 {
				throw PigeonError.authenticationFailed
			}
			throw PigeonError.server(statusCode: httpResponse.statusCode, message: message)
		}
	}
}

private struct EngagementEnvelope: Codable, Sendable {
	let events: [EngagementEvent]
}
