import Foundation
@testable import PigeonReader

actor ControlledHTTPClient: HTTPClient {
	struct PendingRequest: Sendable {
		let id: Int
		let request: URLRequest
	}

	private var nextID = 0
	private var pendingContinuations: [Int: CheckedContinuation<(Data, URLResponse), any Error>] = [:]
	private var unannouncedRequests: [PendingRequest] = []
	private var requestWaiters: [CheckedContinuation<PendingRequest, Never>] = []

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
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
