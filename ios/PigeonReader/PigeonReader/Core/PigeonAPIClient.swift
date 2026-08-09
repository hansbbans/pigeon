import Foundation

struct RecommendationsResponse: Codable, Sendable {
	let generatedAt: Date
	let view: String
	let items: [Recommendation]
}

struct PigeonAPIClient: Sendable {
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

	private var decoder: JSONDecoder {
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
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
