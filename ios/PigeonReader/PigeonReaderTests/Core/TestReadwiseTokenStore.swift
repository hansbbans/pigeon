import Foundation
@testable import PigeonReader

@MainActor
final class TestReadwiseTokenStore: ReadwiseTokenStore {
	private(set) var token: String?

	init(token: String? = nil) {
		self.token = token
	}

	func load() throws -> String? {
		token
	}

	func save(_ token: String) throws {
		self.token = token
	}

	func remove() throws {
		token = nil
	}
}
