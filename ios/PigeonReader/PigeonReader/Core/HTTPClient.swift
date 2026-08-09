import Foundation

protocol HTTPClient: Sendable {
	func data(for request: URLRequest) async throws -> (Data, URLResponse)
}
struct URLSessionHTTPClient: HTTPClient, Sendable {
	private let session: URLSession

	init(session: URLSession = .shared) {
		self.session = session
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		try await session.data(for: request)
	}
}
