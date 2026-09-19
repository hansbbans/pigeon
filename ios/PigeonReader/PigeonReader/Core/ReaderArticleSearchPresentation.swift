/// Pending is derived from the visible query, so it includes the typing debounce.
nonisolated struct ReaderArticleSearchPresentation {
	enum Phase: Equatable {
		case idle, searching, results, failed
	}

	private var settledRequest: ReaderArticleSearchRequest?
	private var resultRequest: ReaderArticleSearchRequest?
	private var didFail = false

	func phase(for request: ReaderArticleSearchRequest) -> Phase {
		guard request.isActive else { return .idle }
		guard settledRequest == request else { return .searching }
		return didFail ? .failed : .results
	}

	func canDisplayResults(for request: ReaderArticleSearchRequest) -> Bool {
		request.isActive && resultRequest?.sharesResultContext(with: request) == true
	}

	mutating func finish(
		_ request: ReaderArticleSearchRequest,
		outcome: ReaderArticleSearchOutcome,
		current: ReaderArticleSearchRequest,
	) {
		guard request == current, outcome != .cancelled else { return }
		settledRequest = request
		didFail = outcome == .failed
		if outcome == .completed { resultRequest = request }
	}
}
