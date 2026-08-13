import Foundation

@MainActor
struct ReadwiseAPIClient {
	private let tokenStore: any ReadwiseTokenStore
	private let httpClient: any HTTPClient

	init(
		tokenStore: any ReadwiseTokenStore,
		httpClient: any HTTPClient = URLSessionHTTPClient()
	) {
		self.tokenStore = tokenStore
		self.httpClient = httpClient
	}

	func save(url: URL) async throws {
		guard let token = try tokenStore.load(), token.isEmpty == false else {
			throw ReadwiseSaveError.missingToken
		}

		try Task.checkCancellation()
		var request = URLRequest(url: Self.saveEndpoint)
		request.httpMethod = "POST"
		request.setValue("Token \(token)", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONEncoder().encode(["url": url.absoluteString])

		let response: URLResponse
		do {
			(_, response) = try await httpClient.data(for: request)
		} catch is CancellationError {
			throw CancellationError()
		} catch {
			throw ReadwiseSaveError.network
		}

		try Task.checkCancellation()
		guard let httpResponse = response as? HTTPURLResponse else {
			throw ReadwiseSaveError.invalidResponse
		}
		switch httpResponse.statusCode {
		case 200, 201:
			return
		case 401:
			throw ReadwiseSaveError.authenticationFailed
		default:
			throw ReadwiseSaveError.server(statusCode: httpResponse.statusCode)
		}
	}

	private static var saveEndpoint: URL {
		guard let url = URL(string: "https://readwise.io/api/v3/save/") else {
			preconditionFailure("The Readwise save endpoint must be a valid URL")
		}
		return url
	}
}
