import Foundation
@testable import PigeonReader

actor RacingNavigationHTTPClient: HTTPClient {
	private enum Generation: Equatable {
		case stale
		case fresh
	}

	private struct PendingRequest {
		let request: URLRequest
		let continuation: CheckedContinuation<(Data, URLResponse), any Error>
	}

	private var requestCount = 0
	private var firstSnapshotRequests: [PendingRequest] = []
	private var firstSnapshotWaiters: [CheckedContinuation<Void, Never>] = []

	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		let generation: Generation = requestCount < 4 ? .stale : .fresh
		requestCount += 1

		if generation == .stale {
			return try await withCheckedThrowingContinuation { continuation in
				firstSnapshotRequests.append(PendingRequest(request: request, continuation: continuation))
				guard firstSnapshotRequests.count == 4 else {
					return
				}
				let waiters = firstSnapshotWaiters
				firstSnapshotWaiters.removeAll()
				for waiter in waiters {
					waiter.resume()
				}
			}
		}

		return try Self.response(for: request, generation: generation)
	}

	func waitForFirstSnapshot() async {
		guard firstSnapshotRequests.count < 4 else {
			return
		}
		await withCheckedContinuation { continuation in
			firstSnapshotWaiters.append(continuation)
		}
	}

	func releaseFirstSnapshot() {
		let requests = firstSnapshotRequests
		firstSnapshotRequests.removeAll()
		for pending in requests {
			guard let response = Self.httpResponse(for: pending.request) else {
				pending.continuation.resume(throwing: PigeonError.invalidResponse)
				continue
			}
			pending.continuation.resume(returning: (Self.payload(for: pending.request, generation: .stale), response))
		}
	}

	private static func response(for request: URLRequest, generation: Generation) throws -> (Data, URLResponse) {
		guard let response = httpResponse(for: request) else {
			throw PigeonError.invalidResponse
		}
		return (payload(for: request, generation: generation), response)
	}

	private static func httpResponse(for request: URLRequest) -> HTTPURLResponse? {
		guard let url = request.url else {
			return nil
		}
		return HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)
	}

	private static func payload(for request: URLRequest, generation: Generation) -> Data {
		let path = request.url?.path
		switch (path, generation) {
		case ("/reader/api/0/subscription/list", .stale):
			return Data("{\"subscriptions\":[{\"id\":\"feed/1\",\"title\":\"Stale Feed\",\"categories\":[{\"id\":\"user/-/label/Stale\",\"label\":\"Stale\"}],\"url\":\"https://pigeon.test/feed/stale\"}]}".utf8)
		case ("/reader/api/0/subscription/list", .fresh):
			return Data("{\"subscriptions\":[{\"id\":\"feed/1\",\"title\":\"Fresh Feed\",\"categories\":[{\"id\":\"user/-/label/Fresh\",\"label\":\"Fresh\"}],\"url\":\"https://pigeon.test/feed/fresh\"}]}".utf8)
		case ("/reader/api/0/unread-count", .stale):
			return Data("{\"unreadcounts\":[{\"id\":\"feed/1\",\"count\":1},{\"id\":\"user/-/label/Stale\",\"count\":1},{\"id\":\"user/-/state/com.google/reading-list\",\"count\":1}]}".utf8)
		case ("/reader/api/0/unread-count", .fresh):
			return Data("{\"unreadcounts\":[{\"id\":\"feed/1\",\"count\":9},{\"id\":\"user/-/label/Fresh\",\"count\":9},{\"id\":\"user/-/state/com.google/reading-list\",\"count\":9}]}".utf8)
		case ("/reader/api/0/stream/contents", _):
			return Data("{\"id\":\"stream\",\"updated\":0,\"items\":[]}".utf8)
		default:
			return Data("{}".utf8)
		}
	}
}
