import ImageIO
import UIKit

/// Feed favicons, decoded once at the size they are drawn.
///
/// Publishers serve favicons at anything up to several hundred pixels, and the
/// sidebar, Home and folder headings draw them at about 20 points. Each row
/// used to fetch and decode its own full-size copy every time it appeared.
/// This keeps one small decoded image per URL and shares a download between
/// rows that ask for the same icon at once. The bytes themselves are kept on
/// disk by the shared `URLCache`.
final class FeedIconStore {
	static let shared = FeedIconStore()

	/// Large enough for the biggest icon slot at 3x with Dynamic Type headroom.
	nonisolated static let maxPixelSize = 96
	nonisolated static let maximumResponseBytes = 2 * 1024 * 1024

	private let cache = NSCache<NSURL, UIImage>()
	private var loads: [URL: Task<UIImage?, Never>] = [:]
	private let fetch: @Sendable (URL) async throws -> Data

	init(fetch: (@Sendable (URL) async throws -> Data)? = nil) {
		self.fetch = fetch ?? { url in try await Self.fetchLive(from: url) }
		cache.countLimit = 256
	}

	func cachedImage(for url: URL) -> UIImage? {
		cache.object(forKey: url as NSURL)
	}

	func image(for url: URL) async -> UIImage? {
		if let cached = cachedImage(for: url) { return cached }
		if let load = loads[url] { return await load.value }
		let fetch = fetch
		let load = Task.detached(priority: .utility) { () -> UIImage? in
			guard let data = try? await fetch(url) else { return nil }
			return Self.downsampled(data)
		}
		loads[url] = load
		let image = await load.value
		loads[url] = nil
		if let image { cache.setObject(image, forKey: url as NSURL) }
		return image
	}

	nonisolated static func downsampled(_ data: Data, maxPixelSize: Int = maxPixelSize) -> UIImage? {
		guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
		let options: [CFString: Any] = [
			kCGImageSourceCreateThumbnailFromImageAlways: true,
			kCGImageSourceCreateThumbnailWithTransform: true,
			kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
			kCGImageSourceShouldCacheImmediately: true,
		]
		guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
		return UIImage(cgImage: image)
	}

	private nonisolated static func fetchLive(from url: URL) async throws -> Data {
		var request = URLRequest(url: url)
		// A favicon rarely changes; the stored copy is good until the cache evicts it.
		request.cachePolicy = .returnCacheDataElseLoad
		request.timeoutInterval = 15
		request.setValue("image/*", forHTTPHeaderField: "Accept")
		let (data, response) = try await URLSession.shared.data(for: request)
		guard let httpResponse = response as? HTTPURLResponse,
			(200..<300).contains(httpResponse.statusCode),
			data.count <= maximumResponseBytes else {
			throw URLError(.cannotDecodeContentData)
		}
		return data
	}
}
