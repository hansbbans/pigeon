import BackgroundTasks
import Foundation
import Network

nonisolated enum BackgroundRefreshPolicy {
	static func shouldRefresh(pathIsSatisfied: Bool, isConstrained: Bool, allowsLowDataMode: Bool) -> Bool {
		pathIsSatisfied && (allowsLowDataMode || isConstrained == false)
	}
}

nonisolated protocol BackgroundRefreshArticleIdentifying: Sendable {
	var id: String { get }
	var readerId: String { get }
	var isRead: Bool { get }
	var receivedAt: Date { get }
}

extension Recommendation: BackgroundRefreshArticleIdentifying {}

nonisolated struct BackgroundRefreshArticleIdentity: BackgroundRefreshArticleIdentifying, Sendable {
	let id: String
	let readerId: String
	let isRead: Bool
	let receivedAt: Date

	init(id: String, readerId: String, isRead: Bool, receivedAt: Date) {
		self.id = id
		self.readerId = readerId
		self.isRead = isRead
		self.receivedAt = receivedAt
	}

	init(_ article: some BackgroundRefreshArticleIdentifying) {
		self.init(id: article.id, readerId: article.readerId, isRead: article.isRead, receivedAt: article.receivedAt)
	}
}

nonisolated enum BackgroundRefreshArticlePlanner {
	private static func aliases(of article: some BackgroundRefreshArticleIdentifying) -> [String] {
		Array(ReaderArticleIdentity.aliases(id: article.id, readerID: article.readerId))
	}

	static func knownIDs<InMemory: Sequence, Cached: Sequence>(
		inMemory: InMemory,
		cached: Cached,
	) -> Set<String> where InMemory.Element: BackgroundRefreshArticleIdentifying, Cached.Element: BackgroundRefreshArticleIdentifying {
		var result = Set<String>()
		for article in inMemory {
			result.formUnion(aliases(of: article))
		}
		for article in cached {
			result.formUnion(aliases(of: article))
		}
		return result
	}

	static func newArticles<S: Sequence>(
		knownIDs: Set<String>,
		current: S,
	) -> [S.Element] where S.Element: BackgroundRefreshArticleIdentifying {
		var seenIDs = Set<String>()
		return current
			.sorted { left, right in
				if left.receivedAt != right.receivedAt {
					return left.receivedAt > right.receivedAt
				}
				if left.id != right.id {
					return left.id < right.id
				}
				return left.readerId < right.readerId
			}
			.reduce(into: [S.Element]()) { result, article in
				// A first sync, another device's read state, or a collection that
				// was not in the local snapshot can introduce already-read IDs.
				// Those are new to this cache, not new unread mail.
				guard article.isRead == false else {
					return
				}
				let articleAliases = aliases(of: article)
				guard articleAliases.isEmpty == false,
					articleAliases.allSatisfy({ knownIDs.contains($0) == false }),
					articleAliases.allSatisfy({ seenIDs.contains($0) == false }) else {
					return
				}
				seenIDs.formUnion(articleAliases)
				result.append(article)
			}
	}
}

nonisolated enum BackgroundRefreshRegistrationPolicy {
	static let launchQueue = DispatchQueue.main
}

@MainActor
final class BackgroundRefreshManager {
	static let shared = BackgroundRefreshManager()
	static let taskIdentifier = "com.hans.pigeon.reader.refresh"

	private let monitor = NWPathMonitor()
	private let queue = DispatchQueue(label: "com.hans.pigeon.reader.network-path")
	private var registered = false
	private(set) var pathIsSatisfied = true
	private(set) var pathIsConstrained = false
	var refreshHandler: (@MainActor @Sendable () async -> Bool)?
	var pathChangeHandler: (@MainActor @Sendable () async -> Void)?

	private init() {
		monitor.pathUpdateHandler = { [weak self] path in
			let isSatisfied = path.status == .satisfied
			let isConstrained = path.isConstrained
			Task { @MainActor [weak self] in
				guard let self else { return }
				let wasSatisfied = self.pathIsSatisfied
				self.pathIsSatisfied = isSatisfied
				self.pathIsConstrained = isConstrained
				if wasSatisfied == false, isSatisfied {
					await self.pathChangeHandler?()
				}
			}
		}
		monitor.start(queue: queue)
	}

	func register() {
		guard registered == false else { return }
		registered = BGTaskScheduler.shared.register(
			forTaskWithIdentifier: Self.taskIdentifier,
			using: BackgroundRefreshRegistrationPolicy.launchQueue,
		) { task in
			guard let refreshTask = task as? BGAppRefreshTask else {
				task.setTaskCompleted(success: false)
				return
			}
			Task { @MainActor in
				await Self.shared.handle(refreshTask)
			}
		}
	}

	func schedule(earliest: Date = Date().addingTimeInterval(30 * 60)) {
		let request = BGAppRefreshTaskRequest(identifier: Self.taskIdentifier)
		request.earliestBeginDate = earliest
		do {
			try BGTaskScheduler.shared.submit(request)
		} catch {
			// The system may reject duplicate or unavailable requests. Foreground refresh remains available.
		}
	}

	private func handle(_ task: BGAppRefreshTask) async {
		schedule()
		let operation = Task { @MainActor [refreshHandler] in
			await refreshHandler?() ?? false
		}
		task.expirationHandler = { operation.cancel() }
		let succeeded = await operation.value
		task.setTaskCompleted(success: succeeded && operation.isCancelled == false)
	}
}
