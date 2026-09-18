import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
import Synchronization

@testable import PigeonReader

struct ReaderFeedThumbnailTests {
	@Test
	func selectsTheFirstSafeImageURLAndResolvesRelativeSources() throws {
		let baseURL = try #require(URL(string: "https://example.com/newsletter/story"))
		let imageURL = ReaderFeedThumbnailSelection.firstImageURL(
			in: #"<img src="/images/hero.jpg"><img src="javascript:alert(1)">"#,
			baseURL: baseURL,
		)

		#expect(imageURL == URL(string: "https://example.com/images/hero.jpg"))
	}

	@Test
	func thumbnailCacheEvictsLeastRecentlyUsedEntriesWithinItsByteBudget() {
		var cache = ReaderFeedThumbnailMemoryCache<String, String>(capacity: 2, byteCapacity: 5)
		cache.insert("first", for: "first", cost: 2)
		cache.insert("second", for: "second", cost: 2)
		#expect(cache.value(for: "first") == "first")

		cache.insert("third", for: "third", cost: 2)

		#expect(cache.value(for: "first") == "first")
		#expect(cache.value(for: "second") == nil)
		#expect(cache.value(for: "third") == "third")
		#expect(cache.totalCost <= 5)
	}

	@Test
	func concurrentRowsDeduplicateTheFetchAndReuseTheDecodedThumbnail() async {
		let probe = ThumbnailProbe()
		let image = Self.makeFixtureImage()
		let imageURL = URL(string: "https://example.com/image.jpg")!
		let dependencies = ReaderFeedThumbnailPipelineDependencies(
			select: { _, _ in imageURL },
			fetch: { _ in try await probe.fetch() },
			decode: { _, _ in
				await probe.recordDecode()
				return image
			},
		)
		let pipeline = ReaderFeedThumbnailPipeline(
			dependencies: dependencies,
			cacheCapacity: 4,
			cacheByteCapacity: 1_000_000,
			maximumConcurrentLoads: 2,
		)
		let article = Self.makeArticle(id: "story", html: #"<img src="image.jpg">"#)

		let first = Task { await pipeline.thumbnail(for: article, scope: "account-a") }
		await probe.waitForFetchStart()
		let second = Task { await pipeline.thumbnail(for: article, scope: "account-a") }
		await Task.yield()
		#expect(await probe.fetchCount == 1)

		await probe.releaseFetch()
		let firstImage = await first.value
		let secondImage = await second.value
		#expect(firstImage != nil)
		#expect(secondImage != nil)
		#expect(await probe.fetchCount == 1)
		#expect(await probe.decodeCount == 1)

		let cachedImage = await pipeline.thumbnail(for: article, scope: "account-a")
		#expect(cachedImage != nil)
		#expect(await probe.fetchCount == 1)
		#expect(await probe.decodeCount == 1)
	}

	@Test
	func cancelledRowDoesNotPublishOrCacheAStaleDecode() async {
		let probe = ThumbnailProbe()
		let image = Self.makeFixtureImage()
		let imageURL = URL(string: "https://example.com/image.jpg")!
		let dependencies = ReaderFeedThumbnailPipelineDependencies(
			select: { _, _ in imageURL },
			fetch: { _ in try await probe.fetch() },
			decode: { _, _ in
				await probe.recordDecode()
				return image
			},
		)
		let pipeline = ReaderFeedThumbnailPipeline(dependencies: dependencies)
		let article = Self.makeArticle(id: "story", html: #"<img src="image.jpg">"#)

		let cancelled = Task { await pipeline.thumbnail(for: article, scope: "account-a") }
		await probe.waitForFetchStart()
		cancelled.cancel()
		await probe.releaseFetch()
		let cancelledImage = await cancelled.value
		#expect(cancelledImage == nil)
		#expect(await probe.decodeCount == 0)

		let retry = Task { await pipeline.thumbnail(for: article, scope: "account-a") }
		await probe.waitForSecondFetchStart()
		await probe.releaseFetch()
		#expect(await retry.value != nil)
		#expect(await probe.fetchCount == 2)
	}

	@Test
	func creatorCancellationLeavesASecondRowRequestAlive() async {
		let probe = ThumbnailProbe()
		let image = Self.makeFixtureImage()
		let imageURL = URL(string: "https://example.com/image.jpg")!
		let dependencies = ReaderFeedThumbnailPipelineDependencies(
			select: { _, _ in imageURL },
			fetch: { _ in try await probe.fetch() },
			decode: { _, _ in image },
		)
		let pipeline = ReaderFeedThumbnailPipeline(dependencies: dependencies)
		let article = Self.makeArticle(id: "story", html: #"<img src="image.jpg">"#)

		let creator = Task { await pipeline.thumbnail(for: article, scope: "account-a") }
		await probe.waitForFetchStart()
		let survivingRow = Task { await pipeline.thumbnail(for: article, scope: "account-a") }
		for _ in 0..<1_000 where await pipeline.inFlightWaiterCount < 2 {
			await Task.yield()
		}
		#expect(await pipeline.inFlightWaiterCount == 2)

		creator.cancel()
		await probe.releaseFetch()
		#expect(await creator.value == nil)
		#expect(await survivingRow.value != nil)
		#expect(await probe.fetchCount == 1)
	}

	@Test
	func sameLengthContentChangesAndAccountScopesCannotReuseAThumbnail() async {
		let fetchCount = Mutex(0)
		let image = Self.makeFixtureImage()
		let dependencies = ReaderFeedThumbnailPipelineDependencies(
			select: { html, _ in
				URL(string: html.contains("b.jpg") ? "https://example.com/b.jpg" : "https://example.com/a.jpg")
			},
			fetch: { _ in
				fetchCount.withLock { $0 += 1 }
				return Data([1])
			},
			decode: { _, _ in image },
		)
		let pipeline = ReaderFeedThumbnailPipeline(dependencies: dependencies)
		let first = Self.makeArticle(id: "story", html: #"<img src="a.jpg">"#)
		let changed = Self.makeArticle(id: "story", html: #"<img src="b.jpg">"#)

		#expect(await pipeline.thumbnail(for: first, scope: "account-a") != nil)
		#expect(await pipeline.thumbnail(for: changed, scope: "account-a") != nil)
		#expect(await pipeline.thumbnail(for: changed, scope: "account-b") != nil)
		#expect(fetchCount.withLock { $0 } == 3)
	}

	@Test
	func prefetchIsLimitedToTheFirstScreenAndConcurrentLoads() async {
		let probe = ThumbnailConcurrencyProbe()
		let image = Self.makeFixtureImage()
		let dependencies = ReaderFeedThumbnailPipelineDependencies(
			select: { _, _ in URL(string: "https://example.com/image.jpg") },
			fetch: { _ in await probe.fetch() },
			decode: { _, _ in image },
		)
		let pipeline = ReaderFeedThumbnailPipeline(
			dependencies: dependencies,
			maximumConcurrentLoads: 2,
		)
		let articles = (0..<ReaderFeedThumbnailPolicy.firstScreenLimit + 2).map { index in
			Self.makeArticle(id: "story-\(index)", html: #"<img src="image.jpg">"#)
		}

		await pipeline.prefetch(articles: articles, scope: "account-a")

		#expect(await probe.fetchCount == ReaderFeedThumbnailPolicy.firstScreenLimit)
		#expect(await probe.maximumActive <= 2)
	}

	@Test
	func liveImageIODecoderDownsamplesToTheRequestedLongestDimension() async throws {
		let pngData = Self.makeLargePNG()
		let dependencies = ReaderFeedThumbnailPipelineDependencies(
			select: { _, _ in URL(string: "https://example.com/image.png") },
			fetch: { _ in pngData },
		)
		let pipeline = ReaderFeedThumbnailPipeline(dependencies: dependencies)
		let article = Self.makeArticle(id: "large", html: #"<img src="image.png">"#)

		let image = try #require(await pipeline.thumbnail(
			for: article,
			scope: "account-a",
			target: ReaderFeedThumbnailPixelSize(width: 64, height: 48),
		))
		#expect(max(image.width, image.height) <= 64)
	}

	@Test
	func imageLessRowsUseNegativeSelectionCache() async {
		let probe = ThumbnailProbe()
		let selectionCount = Mutex(0)
		let dependencies = ReaderFeedThumbnailPipelineDependencies(
			select: { _, _ in
				selectionCount.withLock { $0 += 1 }
				return nil
			},
			fetch: { _ in
				await probe.recordFetchWithoutData()
				return Data()
			},
			decode: { _, _ in Self.makeFixtureImage() },
		)
		let pipeline = ReaderFeedThumbnailPipeline(dependencies: dependencies)
		let article = Self.makeArticle(id: "no-image", html: "<p>Text only</p>")

		#expect(await pipeline.thumbnail(for: article, scope: "account-a") == nil)
		#expect(await pipeline.thumbnail(for: article, scope: "account-a") == nil)
		#expect(await probe.fetchCount == 0)
		#expect(selectionCount.withLock { $0 } == 1)
	}

	private nonisolated static func makeArticle(id: String, html: String) -> Recommendation {
		Recommendation(
			id: id,
			readerId: id,
			feedKey: "feed",
			source: "Source",
			title: "Title",
			html: html,
			text: "Text",
			originalURL: URL(string: "https://example.com/story"),
			receivedAt: Date(timeIntervalSince1970: 0),
			isRead: false,
			isStarred: false,
			score: 0,
			confidence: 0,
			sampleCount: 0,
			explanation: "",
			learningState: "",
		)
	}

	private nonisolated static func makeFixtureImage() -> CGImage {
		let colorSpace = CGColorSpaceCreateDeviceRGB()
		let context = CGContext(
			data: nil,
			width: 2,
			height: 2,
			bitsPerComponent: 8,
			bytesPerRow: 0,
			space: colorSpace,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
		)!
		return context.makeImage()!
	}

	private nonisolated static func makeLargePNG() -> Data {
		let colorSpace = CGColorSpaceCreateDeviceRGB()
		let context = CGContext(
			data: nil,
			width: 1_024,
			height: 512,
			bitsPerComponent: 8,
			bytesPerRow: 0,
			space: colorSpace,
			bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
		)!
		let image = context.makeImage()!
		let data = NSMutableData()
		let destination = CGImageDestinationCreateWithData(
			data,
			UTType.png.identifier as CFString,
			1,
			nil,
		)!
		CGImageDestinationAddImage(destination, image, nil)
		CGImageDestinationFinalize(destination)
		return data as Data
	}

	private actor ThumbnailProbe {
		private(set) var fetchCount = 0
		private(set) var decodeCount = 0
		private var fetchStartWaiter: CheckedContinuation<Void, Never>?
		private var fetchRelease: CheckedContinuation<Data, Error>?

		func fetch() async throws -> Data {
			fetchCount += 1
			fetchStartWaiter?.resume()
			fetchStartWaiter = nil
			return try await withTaskCancellationHandler {
				try await withCheckedThrowingContinuation { continuation in
					fetchRelease = continuation
					if Task.isCancelled {
						fetchRelease = nil
						continuation.resume(throwing: CancellationError())
					}
				}
			} onCancel: {
				Task { await cancelFetch() }
			}
		}

		func waitForFetchStart() async {
			guard fetchCount == 0 else { return }
			await withCheckedContinuation { continuation in
				fetchStartWaiter = continuation
			}
		}

		func waitForSecondFetchStart() async {
			guard fetchCount < 2 else { return }
			await withCheckedContinuation { continuation in
				fetchStartWaiter = continuation
			}
		}

		func releaseFetch() {
			fetchRelease?.resume(returning: Data([1]))
			fetchRelease = nil
		}

		func recordDecode() {
			decodeCount += 1
		}

		func recordFetchWithoutData() {
			fetchCount += 1
		}

		private func cancelFetch() {
			fetchRelease?.resume(throwing: CancellationError())
			fetchRelease = nil
		}
	}

	private actor ThumbnailConcurrencyProbe {
		private(set) var fetchCount = 0
		private(set) var maximumActive = 0
		private var active = 0

		func fetch() async -> Data {
			fetchCount += 1
			active += 1
			maximumActive = max(maximumActive, active)
			await Task.yield()
			await Task.yield()
			active -= 1
			return Data([1])
		}
	}
}
