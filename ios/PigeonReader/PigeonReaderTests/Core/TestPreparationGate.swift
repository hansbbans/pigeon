import Foundation

/// Holds only the first preparation, allowing a newer operation to finish first.
actor TestPreparationGate {
	private var didPause = false
	private var isReleased = false
	private var pausedWaiters: [CheckedContinuation<Void, Never>] = []
	private var releaseContinuation: CheckedContinuation<Void, Never>?

	func pauseFirst() async {
		guard didPause == false else { return }
		didPause = true
		pausedWaiters.forEach { $0.resume() }
		pausedWaiters.removeAll()
		guard isReleased == false else { return }
		await withCheckedContinuation { releaseContinuation = $0 }
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
