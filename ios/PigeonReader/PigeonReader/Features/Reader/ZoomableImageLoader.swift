import Combine
import Foundation
import UIKit

@MainActor
final class ZoomableImageLoader: ObservableObject {
	enum State {
		case loading
		case loaded(UIImage)
		case failed
	}

	static let maximumResponseBytes = 16 * 1_024 * 1_024
	static let maximumPixelDimension = 4_096

	let url: URL
	private let policy: ReaderRemoteImagePolicy
	private let session: PigeonSession?
	private let cacheKey: ZoomableImageCacheKey
	@Published private(set) var state: State = .loading
	private var activeRequestID: UUID?

	init(
		url: URL,
		policy: ReaderRemoteImagePolicy = .normal,
		session: PigeonSession? = nil,
	) {
		self.url = url
		self.policy = policy
		self.session = session
		self.cacheKey = ZoomableImageCacheKey(url: url, policy: policy, session: session)
	}

	func loadIfNeeded() async {
		if case .loaded = state { return }
		guard activeRequestID == nil else { return }

		let requestID = UUID()
		activeRequestID = requestID
		defer {
			if activeRequestID == requestID {
				activeRequestID = nil
			}
		}

		#if DEBUG
		if ProcessInfo.processInfo.arguments.contains("-reader-image-fixture") {
			guard activeRequestID == requestID, Task.isCancelled == false else { return }
			state = .loaded(Self.debugFixtureImage())
			return
		}
		#endif

		if let cachedImage = ZoomableImageMemoryCache.shared.image(for: cacheKey) {
			guard activeRequestID == requestID, Task.isCancelled == false else { return }
			state = .loaded(cachedImage)
			return
		}

		do {
			let image = try await fetchImage(from: url)
			try Task.checkCancellation()
			guard activeRequestID == requestID else { return }
			ZoomableImageMemoryCache.shared.insert(image, for: cacheKey)
			state = .loaded(image)
		} catch is CancellationError {
			// Leaving the sheet cancels its task; keep the loader ready to retry.
		} catch {
			guard activeRequestID == requestID, Task.isCancelled == false,
				Self.isCancellationError(error) == false else {
				return
			}
			state = .failed
		}
	}

	private func fetchImage(from url: URL) async throws -> UIImage {
		guard var request = PrivacyProxiedImageRequest.loadRequest(
			for: url,
			policy: policy,
			session: session,
		) else {
			throw URLError(.badURL)
		}
		// The proxy URL is shared across accounts. Keep its URLSession cache out of
		// the account boundary; the in-memory cache above is already scoped by the
		// authenticated session and remote-image policy.
		request.cachePolicy = policy == .privacyProxied
			? .reloadIgnoringLocalCacheData
			: .returnCacheDataElseLoad
		request.timeoutInterval = 30
		request.setValue("image/*", forHTTPHeaderField: "Accept")
		if policy == .privacyProxied {
			request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
		}

		let (data, response) = try await URLSession.shared.data(for: request)
		try Task.checkCancellation()
		guard data.count <= Self.maximumResponseBytes,
			let httpResponse = response as? HTTPURLResponse,
			(200..<300).contains(httpResponse.statusCode) else {
			throw URLError(.cannotDecodeContentData)
		}

		// UIImageReader performs ImageIO thumbnail decoding asynchronously. The
		// preferred size keeps a large publisher image from becoming a full
		// resolution allocation on the main actor.
		var configuration = UIImageReader.Configuration()
		configuration.preferredThumbnailSize = CGSize(
			width: Self.maximumPixelDimension,
			height: Self.maximumPixelDimension,
		)
		configuration.preparesImagesForDisplay = true
		guard let image = await UIImageReader(configuration: configuration).image(data: data),
			let cgImage = image.cgImage,
			max(cgImage.width, cgImage.height) <= Self.maximumPixelDimension else {
			throw URLError(.cannotDecodeContentData)
		}
		return image
	}

	private static func isCancellationError(_ error: Error) -> Bool {
		if let urlError = error as? URLError {
			return urlError.code == .cancelled
		}
		let nsError = error as NSError
		return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
	}

	#if DEBUG
	private static func debugFixtureImage() -> UIImage {
		let size = CGSize(width: 1_200, height: 800)
		let format = UIGraphicsImageRendererFormat()
		format.scale = 1
		format.opaque = true
		return UIGraphicsImageRenderer(size: size, format: format).image { rendererContext in
			UIColor(red: 0.08, green: 0.11, blue: 0.18, alpha: 1).setFill()
			rendererContext.cgContext.fill(CGRect(origin: .zero, size: size))

			UIColor(red: 0.18, green: 0.56, blue: 0.78, alpha: 1).setFill()
			rendererContext.cgContext.fill(CGRect(x: 80, y: 80, width: 1_040, height: 640))

			UIColor.white.setStroke()
			rendererContext.cgContext.setLineWidth(16)
			rendererContext.cgContext.stroke(
				CGRect(x: 160, y: 160, width: 880, height: 480),
			)
		}
	}
	#endif
}
