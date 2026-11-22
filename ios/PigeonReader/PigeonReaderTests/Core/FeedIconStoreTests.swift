import Foundation
import Testing
import UIKit
@testable import PigeonReader

@MainActor
struct FeedIconStoreTests {
	private static func png(side: CGFloat) -> Data {
		let format = UIGraphicsImageRendererFormat()
		format.scale = 1
		return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).pngData { context in
			UIColor.systemOrange.setFill()
			context.fill(CGRect(x: 0, y: 0, width: side, height: side))
		}
	}

	private actor FetchLog {
		private(set) var count = 0
		func record() { count += 1 }
	}

	@Test func largeFaviconIsDecodedAtIconSize() async throws {
		let data = Self.png(side: 512)
		let store = FeedIconStore(fetch: { _ in data })
		let image = try #require(await store.image(for: URL(string: "https://example.com/favicon.png")!))
		let pixels = try #require(image.cgImage)
		#expect(pixels.width == FeedIconStore.maxPixelSize)
		#expect(pixels.height == FeedIconStore.maxPixelSize)
	}

	@Test func repeatedAndConcurrentRequestsFetchOnce() async throws {
		let data = Self.png(side: 64)
		let log = FetchLog()
		let store = FeedIconStore(fetch: { _ in
			await log.record()
			try await Task.sleep(for: .milliseconds(20))
			return data
		})
		let url = URL(string: "https://example.com/favicon.png")!
		#expect(store.cachedImage(for: url) == nil)

		async let first = store.image(for: url)
		async let second = store.image(for: url)
		let both = await [first, second]
		#expect(both.allSatisfy { $0 != nil })
		#expect(await store.image(for: url) != nil)
		#expect(store.cachedImage(for: url) != nil)
		#expect(await log.count == 1)
	}

	@Test func anIconThatFailedIsNotFetchedAgainStraightAway() async {
		let log = FetchLog()
		let store = FeedIconStore(fetch: { _ in
			await log.record()
			throw URLError(.badServerResponse)
		})
		let url = URL(string: "https://example.com/broken.png")!
		for _ in 0..<5 {
			#expect(await store.image(for: url) == nil)
		}
		#expect(await log.count == 1)
	}

	@Test func failedOrUndecodableIconIsNotCached() async {
		let url = URL(string: "https://example.com/favicon.png")!
		let failing = FeedIconStore(fetch: { _ in throw URLError(.notConnectedToInternet) })
		#expect(await failing.image(for: url) == nil)
		#expect(failing.cachedImage(for: url) == nil)

		let garbage = FeedIconStore(fetch: { _ in Data("not an image".utf8) })
		#expect(await garbage.image(for: url) == nil)
		#expect(garbage.cachedImage(for: url) == nil)
	}
}
