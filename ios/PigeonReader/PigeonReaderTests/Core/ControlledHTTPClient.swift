import Foundation
@testable import PigeonReader

actor ControlledHTTPClient: HTTPClient {
	struct PendingRequest: Sendable {
		let id: Int
		let request: URLRequest
	}

	/// Tests written against change-log rebuilds model a Worker from before the
	/// library listing, so `/api/v1/library` answers 404 at once unless the test
	/// asks to control it like any other request.
	private let controlsLibraryListing: Bool
	private var nextID = 0
	private var pendingContinuations: [Int: CheckedContinuation<(Data, URLResponse), any Error>] = [:]
	private var unannouncedRequests: [PendingRequest] = []
	private var requestWaiters: [CheckedContinuation<PendingRequest, Never>] = []

	init(controlsLibraryListing: Bool = false) {
		self.controlsLibraryListing = controlsLibraryListing
	}

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		if controlsLibraryListing == false, let url = request.url, url.path == "/api/v1/library" {
			guard let response = HTTPURLResponse(url: url, statusCode: 404, httpVersion: nil, headerFields: nil) else {
				throw PigeonError.invalidResponse
			}
			return (Data(#"{"error":"not found"}"#.utf8), response)
		}
		let id = nextID
		nextID += 1
		let pendingRequest = PendingRequest(id: id, request: request)

		return try await withCheckedThrowingContinuation { continuation in
			pendingContinuations[id] = continuation
			if requestWaiters.isEmpty {
				unannouncedRequests.append(pendingRequest)
			} else {
				requestWaiters.removeFirst().resume(returning: pendingRequest)
			}
		}
	}

	func nextRequest() async -> PendingRequest {
		if unannouncedRequests.isEmpty == false {
			return unannouncedRequests.removeFirst()
		}
		return await withCheckedContinuation { continuation in
			requestWaiters.append(continuation)
		}
	}

	func resolve(_ request: PendingRequest, data: Data = Data(), statusCode: Int = 200) {
		guard let continuation = pendingContinuations.removeValue(forKey: request.id) else {
			return
		}
		let url = request.request.url ?? Self.fallbackURL
		guard let response = HTTPURLResponse(url: url, statusCode: statusCode, httpVersion: nil, headerFields: nil) else {
			continuation.resume(throwing: PigeonError.invalidResponse)
			return
		}
		continuation.resume(returning: (data, response))
	}

	func fail(_ request: PendingRequest, with error: any Error) {
		guard let continuation = pendingContinuations.removeValue(forKey: request.id) else {
			return
		}
		continuation.resume(throwing: error)
	}

	func requestCount() -> Int {
		nextID
	}

	private static var fallbackURL: URL {
		guard let url = URL(string: "https://pigeon.test") else {
			preconditionFailure("The test URL must be valid")
		}
		return url
	}
}
