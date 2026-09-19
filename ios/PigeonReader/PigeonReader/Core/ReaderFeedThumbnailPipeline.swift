import CoreGraphics
import Foundation

/// Limits network and decode work shared by visible rows and prefetching.
private actor ReaderFeedThumbnailPermitPool {
	private let limit: Int
	private var inUse = 0
	private var waiters: [UUID: CheckedContinuation<Bool, Never>] = [:]

	init(limit: Int) {
		self.limit = max(limit, 1)
	}

	func acquire() async -> Bool {
		guard Task.isCancelled == false else { return false }
		if inUse < limit {
			inUse += 1
			return true
		}

		let waiterID = UUID()
		return await withTaskCancellationHandler {
			await withCheckedContinuation { continuation in
				if Task.isCancelled {
					continuation.resume(returning: false)
				} else {
					waiters[waiterID] = continuation
				}
			}
		} onCancel: {
			Task { await self.cancelWaiter(waiterID) }
		}
	}

	func release() {
		if let waiterID = waiters.keys.first,
			let continuation = waiters.removeValue(forKey: waiterID) {
			continuation.resume(returning: true)
		} else {
			inUse = max(inUse - 1, 0)
		}
	}

	private func cancelWaiter(_ waiterID: UUID) {
		guard let continuation = waiters.removeValue(forKey: waiterID) else { return }
		continuation.resume(returning: false)
	}
}

/// Tracks waiter cancellation across the actor and detached load task. The
/// cancellation handler must update this state synchronously so a load cannot
/// enter decode after its last row has gone away while actor cleanup is queued.
nonisolated private final class ReaderFeedThumbnailLoadState: @unchecked Sendable {
	private let lock = NSLock()
	private var activeWaiterIDs: Set<UUID>

	init(waiterID: UUID) {
		self.activeWaiterIDs = [waiterID]
	}

	@discardableResult
	func tryAddWaiter(_ waiterID: UUID) -> Bool {
		lock.withLock {
			guard activeWaiterIDs.isEmpty == false else { return false }
			_ = activeWaiterIDs.insert(waiterID)
			return true
		}
	}

	@discardableResult
	func cancelWaiter(_ waiterID: UUID) -> Bool {
		lock.withLock {
			_ = activeWaiterIDs.remove(waiterID)
			return activeWaiterIDs.isEmpty
		}
	}

	func finishWaiter(_ waiterID: UUID) {
		lock.withLock {
			_ = activeWaiterIDs.remove(waiterID)
		}
	}

	func hasActiveWaiter() -> Bool {
		lock.withLock { activeWaiterIDs.isEmpty == false }
	}

	func isActive(_ waiterID: UUID) -> Bool {
		lock.withLock { activeWaiterIDs.contains(waiterID) }
	}
}

actor ReaderFeedThumbnailPipeline {
	private struct CacheKey: Hashable, Sendable {
		let scope: String
		let articleID: String
		let contentDigest: String
		let baseURL: String?
		let target: ReaderFeedThumbnailPixelSize
	}

	private struct InFlight {
		let id: UUID
		let task: Task<LoadResult, Never>
		let loadState: ReaderFeedThumbnailLoadState
		var waiterIDs: Set<UUID>
	}

	private enum LoadResult: Sendable {
		case image(CGImage)
		case noImage
		case failed
	}

	private let dependencies: ReaderFeedThumbnailPipelineDependencies
	private let permitPool: ReaderFeedThumbnailPermitPool
	private var cache: ReaderFeedThumbnailMemoryCache<CacheKey, CGImage>
	private var noImageCache: ReaderFeedThumbnailMemoryCache<CacheKey, Bool>
	private var inFlight: [CacheKey: InFlight] = [:]
	private var generation = UUID()

	var inFlightWaiterCount: Int {
		inFlight.values.reduce(into: 0) { count, entry in
			count += entry.waiterIDs.count
		}
	}

	init(
		dependencies: ReaderFeedThumbnailPipelineDependencies = ReaderFeedThumbnailPipelineDependencies(),
		cacheCapacity: Int = 24,
		cacheByteCapacity: Int = 4 * 1_024 * 1_024,
		maximumConcurrentLoads: Int = ReaderFeedThumbnailPolicy.maximumConcurrentLoads,
	) {
		self.dependencies = dependencies
		self.permitPool = ReaderFeedThumbnailPermitPool(limit: maximumConcurrentLoads)
		self.cache = ReaderFeedThumbnailMemoryCache(
			capacity: cacheCapacity,
			byteCapacity: cacheByteCapacity,
		)
		self.noImageCache = ReaderFeedThumbnailMemoryCache(
			capacity: cacheCapacity,
			byteCapacity: max(cacheCapacity, 1),
		)
	}

	func thumbnail(
		for article: Recommendation,
		scope: String,
		target: ReaderFeedThumbnailPixelSize = ReaderFeedThumbnailPolicy.rowPixelSize,
	) async -> CGImage? {
		guard scope.isEmpty == false, Task.isCancelled == false else { return nil }
		let key = CacheKey(
			scope: scope,
			articleID: article.id,
			contentDigest: ReaderFeedThumbnailContentIdentity.digest(for: article.html),
			baseURL: article.safeOriginalURL?.absoluteString,
			target: target,
		)

		if var existing = inFlight[key] {
			let startedGeneration = generation
			let waiterID = UUID()
			if existing.loadState.tryAddWaiter(waiterID) {
				_ = existing.waiterIDs.insert(waiterID)
				inFlight[key] = existing
				let result = await waitFor(
					existing.task,
					key: key,
					requestID: existing.id,
					waiterID: waiterID,
					loadState: existing.loadState,
				)
				guard Task.isCancelled == false else {
					cancelWaiter(key: key, requestID: existing.id, waiterID: waiterID)
					return nil
				}
				guard generation == startedGeneration else {
					cancelWaiter(key: key, requestID: existing.id, waiterID: waiterID)
					return nil
				}
				return finish(
					result,
					key: key,
					requestID: existing.id,
					waiterID: waiterID,
					generation: startedGeneration,
					loadState: existing.loadState,
				)
			}

			// The previous request has no live waiter and may already have
			// completed its cancellation gate. Retire it before starting fresh.
			if inFlight[key]?.id == existing.id {
				existing.task.cancel()
				inFlight[key] = nil
			}
		}
		if noImageCache.value(for: key) != nil { return nil }
		if let cached = cache.value(for: key) {
			return cached
		}

		let requestID = UUID()
		let startedGeneration = generation
		let html = article.html
		let baseURL = article.safeOriginalURL
		let dependencies = dependencies
		let permitPool = permitPool
		let loadState = ReaderFeedThumbnailLoadState(waiterID: requestID)
		let task = Task.detached(priority: .utility) {
			await Self.load(
				html: html,
				baseURL: baseURL,
				target: target,
				dependencies: dependencies,
				permitPool: permitPool,
				loadState: loadState,
			)
		}
		inFlight[key] = InFlight(
			id: requestID,
			task: task,
			loadState: loadState,
			waiterIDs: [requestID],
		)

		let result = await waitFor(
			task,
			key: key,
			requestID: requestID,
			waiterID: requestID,
			loadState: loadState,
		)
		guard Task.isCancelled == false else {
			cancelWaiter(key: key, requestID: requestID, waiterID: requestID)
			return nil
		}
		guard generation == startedGeneration else {
			cancelWaiter(key: key, requestID: requestID, waiterID: requestID)
			return nil
		}
		return finish(
			result,
			key: key,
			requestID: requestID,
			waiterID: requestID,
			generation: startedGeneration,
			loadState: loadState,
		)
	}

	func prefetch(
		articles: [Recommendation],
		scope: String,
		target: ReaderFeedThumbnailPixelSize = ReaderFeedThumbnailPolicy.rowPixelSize,
	) async {
		guard scope.isEmpty == false, Task.isCancelled == false else { return }
		let candidates = Array(articles.prefix(ReaderFeedThumbnailPolicy.firstScreenLimit))
		await withTaskGroup(of: Void.self) { group in
			for article in candidates {
				group.addTask {
					_ = await self.thumbnail(for: article, scope: scope, target: target)
				}
			}
			await group.waitForAll()
		}
	}

	func reset() {
		generation = UUID()
		inFlight.values.forEach { $0.task.cancel() }
		inFlight.removeAll()
		cache.removeAll()
		noImageCache.removeAll()
	}

	private func waitFor(
		_ task: Task<LoadResult, Never>,
		key: CacheKey,
		requestID: UUID,
		waiterID: UUID,
		loadState: ReaderFeedThumbnailLoadState,
	) async -> LoadResult {
		await withTaskCancellationHandler {
			await task.value
		} onCancel: {
			// Actor cleanup is asynchronous; mark the waiter synchronously so the
			// detached load cannot enter decode during that gap.
			loadState.cancelWaiter(waiterID)
			Task { await self.cancelWaiter(key: key, requestID: requestID, waiterID: waiterID) }
		}
	}

	private func cancelWaiter(key: CacheKey, requestID: UUID, waiterID: UUID) {
		guard var entry = inFlight[key], entry.id == requestID,
			entry.waiterIDs.remove(waiterID) != nil else { return }
		entry.loadState.cancelWaiter(waiterID)
		if entry.waiterIDs.isEmpty {
			entry.task.cancel()
			inFlight[key] = nil
		} else {
			inFlight[key] = entry
		}
	}

	private func finish(
		_ result: LoadResult,
		key: CacheKey,
		requestID: UUID,
		waiterID: UUID,
		generation startedGeneration: UUID,
		loadState: ReaderFeedThumbnailLoadState,
	) -> CGImage? {
		guard Task.isCancelled == false,
			generation == startedGeneration,
			loadState.isActive(waiterID) else {
			finishWaiter(key: key, requestID: requestID, waiterID: waiterID)
			return nil
		}
		if case .image(let image) = result {
			cache.insert(image, for: key, cost: Self.cost(of: image))
		} else if case .noImage = result {
			noImageCache.insert(true, for: key, cost: 1)
		}
		finishWaiter(key: key, requestID: requestID, waiterID: waiterID)
		if case .image(let image) = result { return image }
		return nil
	}

	private func finishWaiter(key: CacheKey, requestID: UUID, waiterID: UUID) {
		guard var entry = inFlight[key], entry.id == requestID,
			entry.waiterIDs.remove(waiterID) != nil else { return }
		entry.loadState.finishWaiter(waiterID)
		if entry.waiterIDs.isEmpty {
			inFlight[key] = nil
		} else {
			inFlight[key] = entry
		}
	}

	private nonisolated static func load(
		html: String,
		baseURL: URL?,
		target: ReaderFeedThumbnailPixelSize,
		dependencies: ReaderFeedThumbnailPipelineDependencies,
		permitPool: ReaderFeedThumbnailPermitPool,
		loadState: ReaderFeedThumbnailLoadState,
	) async -> LoadResult {
		let acquired = await permitPool.acquire()
		guard acquired else { return .failed }
		guard Task.isCancelled == false else {
			await permitPool.release()
			return .failed
		}

		do {
			guard let url = dependencies.select(html, baseURL) else {
				await permitPool.release()
				return .noImage
			}
			let data = try await dependencies.fetch(url)
			try Task.checkCancellation()
			guard loadState.hasActiveWaiter() else {
				await permitPool.release()
				return .failed
			}
			let image = await dependencies.decode(data, target)
			try Task.checkCancellation()
			guard loadState.hasActiveWaiter() else {
				await permitPool.release()
				return .failed
			}
			await permitPool.release()
			guard let image else { return .failed }
			return .image(image)
		} catch {
			await permitPool.release()
			return .failed
		}
	}

	private nonisolated static func cost(of image: CGImage) -> Int {
		let (rowCost, rowOverflowed) = image.bytesPerRow.multipliedReportingOverflow(by: image.height)
		guard rowOverflowed == false else { return Int.max }
		return max(rowCost, 1)
	}
}
