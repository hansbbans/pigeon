import UIKit

nonisolated struct SceneBackgroundTaskID: Hashable, Sendable {
	let rawValue: Int

	static let invalid = SceneBackgroundTaskID(rawValue: UIBackgroundTaskIdentifier.invalid.rawValue)
}

/// Requests extra time after a scene backgrounds so persistence can finish
/// without stalling the scene-update watchdog.
@MainActor
protocol SceneBackgroundTaskRunning: AnyObject {
	func beginTask(name: String, expirationHandler: @escaping @Sendable () -> Void) -> SceneBackgroundTaskID
	func endTask(_ identifier: SceneBackgroundTaskID)
}

@MainActor
final class UIApplicationSceneBackgroundTaskRunner: SceneBackgroundTaskRunning {
	static let shared = UIApplicationSceneBackgroundTaskRunner()

	private init() {}

	func beginTask(name: String, expirationHandler: @escaping @Sendable () -> Void) -> SceneBackgroundTaskID {
		let identifier = UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: expirationHandler)
		return SceneBackgroundTaskID(rawValue: identifier.rawValue)
	}

	func endTask(_ identifier: SceneBackgroundTaskID) {
		let task = UIBackgroundTaskIdentifier(rawValue: identifier.rawValue)
		guard task != .invalid else { return }
		UIApplication.shared.endBackgroundTask(task)
	}
}
