import Foundation

/// Holds only the first preparation, allowing a newer operation to finish first.
actor TestPreparationGate {
	private var didPause = false
	private(set) var wasCancelled = false
	private var isReleased = false
	private var pausedWaiters: [CheckedContinuation<Void, Never>] = []
	private var releaseContinuation: CheckedContinuation<Void, Never>?

	@discardableResult
	func pauseFirst() async -> Bool {
		guard didPause == false else { return false }
		didPause = true
		pausedWaiters.forEach { $0.resume() }
		pausedWaiters.removeAll()
		guard isReleased == false else { return true }
		await withCheckedContinuation { releaseContinuation = $0 }
		wasCancelled = Task.isCancelled
		return true
	}

	func waitUntilPaused() async {
		guard didPause == false else { return }
		await withCheckedContinuation { pausedWaiters.append($0) }
	}

	func release() {
		isReleased = true
		releaseContinuation?.resume()
		releaseContinuation = nil
	}
}
