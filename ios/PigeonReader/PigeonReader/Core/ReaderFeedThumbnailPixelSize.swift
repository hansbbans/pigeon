import CoreGraphics

/// The decoded size used by image-rich timeline rows. The row is 72×54 points,
/// so this retains enough pixels for a 3× display without retaining publisher
/// originals.
nonisolated struct ReaderFeedThumbnailPixelSize: Hashable, Sendable {
	let width: Int
	let height: Int

	init(width: Int, height: Int) {
		self.width = max(width, 1)
		self.height = max(height, 1)
	}

	var cgSize: CGSize {
		CGSize(width: width, height: height)
	}
}
