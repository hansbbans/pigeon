import Foundation

/// Selection and explicit publisher-loading permission belong to one exact
/// row request. A policy, account, or content change revokes the old permission.
nonisolated struct ArticleRowThumbnailState {
	private(set) var request: ArticleRowThumbnailRequest?
	private var selectedURL: URL?
	private var hasSelectedURL = false
	private var didRequestBlockedLoad = false

	/// Returns whether this activation still needs background URL discovery.
	mutating func activate(_ request: ArticleRowThumbnailRequest) -> Bool {
		if self.request != request {
			self.request = request
			selectedURL = nil
			hasSelectedURL = false
			didRequestBlockedLoad = false
		}
		return request.needsURLSelection && hasSelectedURL == false
	}

	mutating func completeSelection(_ url: URL?, for request: ArticleRowThumbnailRequest) {
		guard self.request == request else { return }
		selectedURL = url
		hasSelectedURL = true
	}

	func url(for request: ArticleRowThumbnailRequest) -> URL? {
		self.request == request ? selectedURL : nil
	}

	func requestedBlockedLoad(for request: ArticleRowThumbnailRequest) -> Bool {
		self.request == request && didRequestBlockedLoad
	}

	mutating func requestBlockedLoad(for request: ArticleRowThumbnailRequest) {
		guard self.request == request, request.policy == .blocked, selectedURL != nil else { return }
		didRequestBlockedLoad = true
	}
}
