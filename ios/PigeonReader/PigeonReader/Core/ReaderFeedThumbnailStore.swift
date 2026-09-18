import CoreGraphics
import Foundation

@MainActor
final class ReaderFeedThumbnailStore {
	static let shared = ReaderFeedThumbnailStore()

	private let pipeline: ReaderFeedThumbnailPipeline

	init(
		dependencies: ReaderFeedThumbnailPipelineDependencies = ReaderFeedThumbnailPipelineDependencies(),
		cacheCapacity: Int = 24,
		cacheByteCapacity: Int = 4 * 1_024 * 1_024,
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
