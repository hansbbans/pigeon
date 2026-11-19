import CoreGraphics
import Foundation

@MainActor
final class ReaderFeedThumbnailStore {
	static let shared = ReaderFeedThumbnailStore()

	private let pipeline: ReaderFeedThumbnailPipeline

	init(
		dependencies: ReaderFeedThumbnailPipelineDependencies = ReaderFeedThumbnailPipelineDependencies(),
		// A Front Page lead image is about 2.4 MB decoded and a row thumbnail
		// about 140 KB. The earlier 4 MB held one lead image and a few rows, so
		// scrolling back decoded most images again.
		cacheCapacity: Int = 64,
		cacheByteCapacity: Int = 16 * 1_024 * 1_024,
		maximumConcurrentLoads: Int = ReaderFeedThumbnailPolicy.maximumConcurrentLoads,
	) {
		pipeline = ReaderFeedThumbnailPipeline(
			dependencies: dependencies,
			cacheCapacity: cacheCapacity,
			cacheByteCapacity: cacheByteCapacity,
			maximumConcurrentLoads: maximumConcurrentLoads,
		)
	}

	func thumbnail(
		for article: Recommendation,
		scope: String,
		target: ReaderFeedThumbnailPixelSize = ReaderFeedThumbnailPolicy.rowPixelSize,
	) async -> CGImage? {
		await pipeline.thumbnail(for: article, scope: scope, target: target)
	}

	func prefetch(
		articles: [Recommendation],
		scope: String,
		target: ReaderFeedThumbnailPixelSize = ReaderFeedThumbnailPolicy.rowPixelSize,
	) async {
		await pipeline.prefetch(articles: articles, scope: scope, target: target)
	}

	func reset() {
		Task { await pipeline.reset() }
	}
}
