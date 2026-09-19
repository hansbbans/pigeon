import UIKit

nonisolated struct ZoomableImageCacheKey: Hashable, Sendable {
	let url: URL
	let policy: ReaderRemoteImagePolicy
	let sessionScope: String

	@MainActor
	init(url: URL, policy: ReaderRemoteImagePolicy, session: PigeonSession?) {
		self.url = url
		self.policy = policy
		self.sessionScope = session?.storageIdentity ?? "no-session"
	}

	var cacheIdentifier: String {
		[
			url.absoluteString,
			policy.rawValue,
			sessionScope,
		].joined(separator: "\u{0}")
	}
}

@MainActor
final class ZoomableImageMemoryCache {
	static let shared = ZoomableImageMemoryCache()

	private let cache: NSCache<NSString, UIImage>

	init(countLimit: Int = 12, totalCostLimit: Int = 64 * 1_024 * 1_024) {
		cache = NSCache<NSString, UIImage>()
		cache.countLimit = max(countLimit, 1)
		cache.totalCostLimit = max(totalCostLimit, 1)
	}

	func image(for key: ZoomableImageCacheKey) -> UIImage? {
		cache.object(forKey: key.cacheIdentifier as NSString)
	}

	func insert(_ image: UIImage, for key: ZoomableImageCacheKey) {
		cache.setObject(image, forKey: key.cacheIdentifier as NSString, cost: Self.cost(of: image))
	}

	private static func cost(of image: UIImage) -> Int {
		guard let cgImage = image.cgImage else { return 1 }
		let (rowCost, overflowed) = cgImage.bytesPerRow.multipliedReportingOverflow(by: cgImage.height)
		return overflowed ? Int.max : max(rowCost, 1)
	}
}
