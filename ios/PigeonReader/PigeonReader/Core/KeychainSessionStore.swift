import Foundation
import Security

/// The session lives in the app group's keychain access group so the share
/// extension can save links. The first read after updating moves the item
/// from the app's private access group (see `SharedSessionKeychain.load`).
@MainActor
final class KeychainSessionStore: SessionStore {
	private let keychain: SharedSessionKeychain

	init(keychain: SharedSessionKeychain = SharedSessionKeychain()) {
		self.keychain = keychain
	}

	func load() throws -> PigeonSession? {
		do {
			guard let data = try keychain.load() else { return nil }
			return try JSONDecoder().decode(PigeonSession.self, from: data)
		} catch let error as KeychainAccessError {
			throw PigeonError.keychain(status: error.status)
		}
	}

	func save(_ session: PigeonSession) throws {
		let data = try JSONEncoder().encode(session)
		do {
			try keychain.save(data)
		} catch let error as KeychainAccessError {
			throw PigeonError.keychain(status: error.status)
		}
	}

	func remove() throws {
		do {
			try keychain.remove()
		} catch let error as KeychainAccessError {
			throw PigeonError.keychain(status: error.status)
		}
	}
}
