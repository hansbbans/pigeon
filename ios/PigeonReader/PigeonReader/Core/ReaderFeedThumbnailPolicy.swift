import Foundation

nonisolated enum ReaderFeedThumbnailPolicy {
	static let firstScreenLimit = 8
	static let maximumConcurrentLoads = 4
	static let maximumResponseBytes = 8 * 1_024 * 1_024
	static let rowPixelSize = ReaderFeedThumbnailPixelSize(width: 216, height: 162)
}
