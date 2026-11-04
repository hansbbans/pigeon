import Foundation

/// Pigeon's own Read It Later replaced Readwise Reader. Builds before it kept
/// a Readwise access token in the keychain; delete it, and the flag that
/// queued its server backup. The Worker's Readwise endpoints stay for older
/// builds and are removed separately.
nonisolated enum LegacyReadwiseCleanup {
	static let keychainService = "com.hans.pigeon.reader.readwise"
	static let keychainAccount = "access-token"
	static let pendingServerSyncKey = "pigeon.readwise.pending-server-sync.v1"
	static let completedKey = "pigeon.readwise.removed.v1"

	static func run(keychain: any KeychainItemAccessing = SystemKeychain(), defaults: UserDefaults = .standard) {
		guard defaults.bool(forKey: completedKey) == false else { return }
		do {
			try keychain.deleteItems(service: keychainService, account: keychainAccount, accessGroup: nil)
		} catch {
			// Try again next launch.
			return
		}
		defaults.removeObject(forKey: pendingServerSyncKey)
		defaults.set(true, forKey: completedKey)
	}
}
