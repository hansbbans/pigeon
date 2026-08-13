import Foundation
@testable import PigeonReader

actor MockHTTPClient: HTTPClient {
	struct RequestSnapshot: Sendable {
		let url: URL
		let method: String?
		let authorization: String?
		let accept: String?
		let contentType: String?
		let body: Data?
	}

	private let responseData: Data
	private let statusCode: Int
	private let shouldFail: Bool
	private var snapshots: [RequestSnapshot] = []

	init(responseData: Data = Data(), statusCode: Int = 200, shouldFail: Bool = false) {
		self.responseData = responseData
		self.statusCode = statusCode
		self.shouldFail = shouldFail
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		if shouldFail {
			throw URLError(.notConnectedToInternet)
		}
		let fallbackURL = Self.fallbackURL
		let url = request.url ?? fallbackURL
		guard let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil) else {
			fatalError("Unable to create a test HTTP response")
		}
		snapshots.append(
			RequestSnapshot(
				url: url,
				method: request.httpMethod,
				authorization: request.value(forHTTPHeaderField: "Authorization"),
				accept: request.value(forHTTPHeaderField: "Accept"),
				contentType: request.value(forHTTPHeaderField: "Content-Type"),
				body: request.httpBody,
			)
		)
		return (responseData, response)
	}

	func lastRequest() -> RequestSnapshot? {
		snapshots.last
	}

	func requests() -> [RequestSnapshot] {
		snapshots
	}

	private static var fallbackURL: URL {
		guard let url = URL(string: "https://pigeon.test") else {
			fatalError("Unable to create test URL")
		}
		return url
	}
}
