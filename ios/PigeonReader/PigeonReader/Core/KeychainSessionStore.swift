import Foundation
import Security

@MainActor
final class KeychainSessionStore: SessionStore {
	private let service = "com.hans.pigeon.reader"
	private let account = "session"

	func load() throws -> PigeonSession? {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
			kSecReturnData as String: true,
		]
		var result: CFTypeRef?
		let status = SecItemCopyMatching(query as CFDictionary, &result)
		if status == errSecItemNotFound {
			return nil
		}
		guard status == errSecSuccess, let data = result as? Data else {
			throw PigeonError.keychain(status: status)
		}
		return try JSONDecoder().decode(PigeonSession.self, from: data)
	}

	func save(_ session: PigeonSession) throws {
		try remove()
		let data = try JSONEncoder().encode(session)
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
			kSecValueData as String: data,
			kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
		]
		let status = SecItemAdd(query as CFDictionary, nil)
		guard status == errSecSuccess else {
			throw PigeonError.keychain(status: status)
		}
	}

	func remove() throws {
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
		]
		let status = SecItemDelete(query as CFDictionary)
		guard status == errSecSuccess || status == errSecItemNotFound else {
			throw PigeonError.keychain(status: status)
		}
	}
}
