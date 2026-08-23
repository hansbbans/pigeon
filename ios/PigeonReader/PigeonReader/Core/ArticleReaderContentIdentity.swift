import Foundation

/// Identity for the Feed Content / Reader View scroll column.
///
/// The iPad detail pane reuses `ArticleReaderView`. Without a new identity,
/// `ScrollView` keeps the previous story's offset, so the next newsletter can
/// open already scrolled. Website mode is a separate Safari identity.
struct ArticleReaderContentIdentity: Hashable, Sendable {
	let articleID: String
	let mode: ReaderMode

	/// Saved progress is per story. Switching modes is a different document
	/// and should start at the top instead of keeping the previous offset.
	static func pendingRestoredDepth(
		previous: ArticleReaderContentIdentity?,
		current: ArticleReaderContentIdentity,
		savedDepth: Double,
	) -> Double {
		if previous?.articleID == current.articleID {
			return 0
		}
		return min(max(savedDepth, 0), 1)
	}
}
