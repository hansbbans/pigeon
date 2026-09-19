import Foundation

/// Only the bounded first screen participates in task identity. Including the
/// article values also invalidates preparation when a refresh changes HTML
/// while retaining the same story identifiers.
nonisolated struct ReaderFeedThumbnailPrefetchRequest: Equatable, Sendable {
	let scope: String?
	let articles: [Recommendation]
}
