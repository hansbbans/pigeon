import Foundation

/// A destination starts pending before its task runs. A completed empty cache
/// is different from a collection whose first request has not finished.
nonisolated struct ReaderCollectionLoadingState {
	enum Presentation: Equatable {
		case content, loading, unavailable
	}

	private var context: String?
	private var requestID: UUID?
	private var completed = false

	mutating func begin(context: String) -> UUID {
		let id = UUID()
		self.context = context
		requestID = id
		completed = false
		return id
	}

	mutating func finish(requestID: UUID) {
		guard self.requestID == requestID else { return }
		completed = true
	}

	func presentation(context: String, hasCachedCollection: Bool, isLoading: Bool) -> Presentation {
		if hasCachedCollection { return .content }
		if self.context != context || completed == false || isLoading { return .loading }
		return .unavailable
	}
}
