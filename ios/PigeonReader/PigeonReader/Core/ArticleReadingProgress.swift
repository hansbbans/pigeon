import Foundation

/// How far through an article the user has revealed.
///
/// Used by After 60% Read and scroll-depth analytics. The reader must not treat
/// the header-only first layout as 100% read: `StructuredHTMLView` starts at a
/// placeholder height, then grows once the newsletter HTML is measured.
nonisolated enum ArticleReadingProgress {
	/// Returns a 0...1 reading depth.
	///
	/// When the body has not finished laying out, this is 0. When the laid-out
	/// story fits on screen (`maximumOffset` is ~0), this is 1 so short
	/// newsletters can still satisfy After 60% Read.
	static func depth(
		offset: Double,
		maximumOffset: Double,
		contentHeight: Double,
		isBodyLaidOut: Bool,
	) -> Double {
		guard isBodyLaidOut, contentHeight > 1 else {
			return 0
		}
		if maximumOffset <= 1 {
			return 1
		}
		return min(max(offset / maximumOffset, 0), 1)
	}
}
