import CoreGraphics
import Foundation
import ImageIO

nonisolated struct ReaderFeedThumbnailPipelineDependencies: Sendable {
	let select: @Sendable (String, URL?) -> URL?
	let fetch: @Sendable (URL) async throws -> Data
	let decode: @Sendable (Data, ReaderFeedThumbnailPixelSize) async -> CGImage?

	init(
		select: (@Sendable (String, URL?) -> URL?)? = nil,
		fetch: (@Sendable (URL) async throws -> Data)? = nil,
		decode: (@Sendable (Data, ReaderFeedThumbnailPixelSize) async -> CGImage?)? = nil,
	) {
		self.select = select ?? { html, baseURL in ReaderFeedThumbnailSelection.firstImageURL(in: html, baseURL: baseURL) }
		self.fetch = fetch ?? { url in try await Self.fetchLive(from: url) }
		self.decode = decode ?? { data, target in await Self.decodeLive(data: data, target: target) }
	}

	private static func fetchLive(from url: URL) async throws -> Data {
		var request = URLRequest(url: url)
		request.cachePolicy = .returnCacheDataElseLoad
		request.timeoutInterval = 15
		request.setValue("image/*", forHTTPHeaderField: "Accept")
		let (bytes, response) = try await URLSession.shared.bytes(for: request)
		defer { bytes.task.cancel() }
		if response.expectedContentLength > Int64(ReaderFeedThumbnailPolicy.maximumResponseBytes) {
			throw URLError(.dataLengthExceedsMaximum)
		}
		guard let httpResponse = response as? HTTPURLResponse,
			(200..<300).contains(httpResponse.statusCode) else {
			throw URLError(.cannotDecodeContentData)
		}

		var data = Data()
		if response.expectedContentLength > 0 {
			data.reserveCapacity(min(Int(response.expectedContentLength), ReaderFeedThumbnailPolicy.maximumResponseBytes))
		}
		for try await byte in bytes {
			try Task.checkCancellation()
			guard data.count < ReaderFeedThumbnailPolicy.maximumResponseBytes else {
				throw URLError(.dataLengthExceedsMaximum)
			}
			data.append(byte)
		}
		return data
	}

	private static func decodeLive(
		data: Data,
		target: ReaderFeedThumbnailPixelSize,
	) async -> CGImage? {
		guard Task.isCancelled == false else { return nil }
		guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
			return nil
		}
		let options: [CFString: Any] = [
			kCGImageSourceCreateThumbnailFromImageAlways: true,
			kCGImageSourceCreateThumbnailWithTransform: true,
			kCGImageSourceThumbnailMaxPixelSize: max(target.width, target.height),
			kCGImageSourceShouldCacheImmediately: true,
		]
		guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
			Task.isCancelled == false else {
			return nil
		}
		return image
	}
}
