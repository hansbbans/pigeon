import SwiftUI

nonisolated enum SceneLifecycleAction: Equatable, Sendable {
	case becomeActive
	case resignActive
	case flushInBackground
}

/// Scene-phase work must stay cheap. Refresh and persistence run after the
/// handler returns, and only backgrounding asks for extra process time.
nonisolated enum SceneLifecyclePolicy {
	static func action(for phase: ScenePhase) -> SceneLifecycleAction {
		switch phase {
		case .active:
			return .becomeActive
		case .inactive:
			return .resignActive
		case .background:
			return .flushInBackground
		@unknown default:
			return .resignActive
		}
	}
}
