import Foundation
import Security

@MainActor
final class KeychainReadwiseTokenStore: ReadwiseTokenStore {
	private let service = "com.hans.pigeon.reader.readwise"
	private let account = "access-token"

	func load() throws -> String? {
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
			throw PigeonError.readwiseKeychain(status: status)
		}
		guard let token = String(data: data, encoding: .utf8), token.isEmpty == false else {
			throw PigeonError.invalidReadwiseToken
		}
		return token
	}

	func save(_ token: String) throws {
		let normalizedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
		guard normalizedToken.isEmpty == false else {
			throw PigeonError.invalidReadwiseToken
		}

		try remove()
		guard let data = normalizedToken.data(using: .utf8) else {
			throw PigeonError.invalidReadwiseToken
		}
		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
			kSecValueData as String: data,
			kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
		]
		let status = SecItemAdd(query as CFDictionary, nil)
		guard status == errSecSuccess else {
			throw PigeonError.readwiseKeychain(status: status)
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
			throw PigeonError.readwiseKeychain(status: status)
		}
	}
}
