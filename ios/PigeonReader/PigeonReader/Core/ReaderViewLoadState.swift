import Foundation

enum ReaderViewLoadState: Equatable, Sendable {
	case idle
	case loading
	case loaded
	case unavailable
	case failed(String)
	case fallback(String)
}

enum ReaderViewDocumentOwnership {
	/// Apply an extracted document only to the story that requested it.
	static func shouldApply(extractedArticleID: String, visibleArticleID: String) -> Bool {
		extractedArticleID == visibleArticleID
	}

	/// Hide a leftover document or error from the previous story until the new extract finishes.
	static func presentedState(
		stored: ReaderViewLoadState,
		documentArticleID: String?,
		visibleArticleID: String,
	) -> ReaderViewLoadState {
		guard let documentArticleID, documentArticleID != visibleArticleID else {
			return stored
		}
		switch stored {
		case .idle, .loading:
			return stored
		case .loaded, .unavailable, .failed, .fallback:
			return .loading
		}
	}
}
