import Foundation
@testable import PigeonReader

@MainActor
final class TestSessionStore: SessionStore {
	private var session: PigeonSession?

	init(session: PigeonSession? = nil) {
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
