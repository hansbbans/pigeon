import Foundation
import Observation

@MainActor
@Observable
final class SyncHealthViewModel {
	enum LoadState: Equatable {
		case idle
		case loading
		case loaded
		case failed(String)
	}

	private(set) var state = LoadState.idle
	private(set) var snapshot: SyncHealthSnapshot?
	private(set) var retryingFeedKeys = Set<String>()
	private(set) var retryErrors: [String: String] = [:]

	private let service: any SyncHealthServicing
	private var activeLoadID: UUID?

	init(service: any SyncHealthServicing) {
		self.service = service
	}

	func load() async {
		let loadID = UUID()
		activeLoadID = loadID
		state = .loading

		do {
			let loadedSnapshot = try await service.syncHealth()
			try Task.checkCancellation()
			guard activeLoadID == loadID else { return }
			snapshot = loadedSnapshot
			state = .loaded
		} catch let error where isCancellation(error) {
			guard activeLoadID == loadID else { return }
			state = snapshot == nil ? .idle : .loaded
		} catch {
			guard activeLoadID == loadID else { return }
			state = .failed(error.localizedDescription)
		}
	}

	func retry(_ feed: SyncHealthFeed) async {
		guard feed.canRetry, retryingFeedKeys.contains(feed.feedKey) == false else { return }
		retryingFeedKeys.insert(feed.feedKey)
		retryErrors[feed.feedKey] = nil
		defer { retryingFeedKeys.remove(feed.feedKey) }

		do {
			try await service.retryFeed(feedKey: feed.feedKey)
			try Task.checkCancellation()
			await load()
		} catch let error where isCancellation(error) {
			return
		} catch {
			retryErrors[feed.feedKey] = error.localizedDescription
		}
	}

	func isRetrying(_ feed: SyncHealthFeed) -> Bool {
		retryingFeedKeys.contains(feed.feedKey)
	}
}
