import BackgroundTasks
import Foundation
import Network

nonisolated enum BackgroundRefreshPolicy {
	static func shouldRefresh(pathIsSatisfied: Bool, isConstrained: Bool, allowsLowDataMode: Bool) -> Bool {
		pathIsSatisfied && (allowsLowDataMode || isConstrained == false)
	}
}

nonisolated enum BackgroundRefreshArticlePlanner {
	static func knownIDs(inMemory: [Recommendation], cached: [Recommendation]) -> Set<String> {
		Set((inMemory + cached).map(\.id))
	}

	static func newArticles(knownIDs: Set<String>, current: [Recommendation]) -> [Recommendation] {
		current.reduce(into: [String: Recommendation]()) { result, article in
			if knownIDs.contains(article.id) == false { result[article.id] = article }
		}.values.sorted { $0.receivedAt > $1.receivedAt }
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

	private init() {
		monitor.pathUpdateHandler = { [weak self] path in
			let isSatisfied = path.status == .satisfied
			let isConstrained = path.isConstrained
			Task { @MainActor [weak self] in
				self?.pathIsSatisfied = isSatisfied
				self?.pathIsConstrained = isConstrained
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
