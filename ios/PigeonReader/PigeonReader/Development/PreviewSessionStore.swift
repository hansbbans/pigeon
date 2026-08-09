#if DEBUG
import Foundation

@MainActor
final class PreviewSessionStore: SessionStore {
	private var session: PigeonSession?

	init(session: PigeonSession?) {
		self.session = session
	}

	func load() throws -> PigeonSession? {
		session
	}

	func save(_ session: PigeonSession) throws {
		self.session = session
	}

	func remove() throws {
		session = nil
	}
}
#endif
