import Foundation

/// URL discovery is local and independent of loading permission. Normal rows
/// already discover their image through the bounded thumbnail pipeline.
nonisolated struct ArticleRowThumbnailRequest: Equatable, Sendable {
	let articleID: String
	let html: String
	let baseURL: URL?
	let scope: String?
	let policy: ReaderRemoteImagePolicy
	let isImageRich: Bool

	var needsURLSelection: Bool {
		isImageRich && policy != .normal
	}

	func selectURL() -> URL? {
		guard needsURLSelection else { return nil }
		return ReaderFeedThumbnailSelection.firstImageURL(in: html, baseURL: baseURL)
	}
}
