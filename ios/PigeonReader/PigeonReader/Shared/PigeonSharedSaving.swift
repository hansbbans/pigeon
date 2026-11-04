import Foundation
import Security

// Shared by the app and PigeonShareExtension: the API session in a keychain
// access group both can read, and the queue of links saved while offline.

// MARK: - Keychain

nonisolated struct KeychainItem: Equatable, Sendable {
	let data: Data
	/// The access group the item lives in, as reported by the keychain.
	let accessGroup: String?
}

nonisolated struct KeychainAccessError: Error, Equatable, Sendable {
	let status: OSStatus

	/// Unsigned simulator builds have no entitlements, so they cannot use an
	/// app group as a keychain access group.
	var isMissingEntitlement: Bool { status == errSecMissingEntitlement }
}

nonisolated protocol KeychainItemAccessing: Sendable {
	/// A nil group searches every group the process can read.
	func copyItem(service: String, account: String, accessGroup: String?) throws -> KeychainItem?
	func addItem(_ data: Data, service: String, account: String, accessGroup: String?) throws
	/// A nil group deletes the item from every group the process can read.
	func deleteItems(service: String, account: String, accessGroup: String?) throws
}

nonisolated struct SystemKeychain: KeychainItemAccessing {
	func copyItem(service: String, account: String, accessGroup: String?) throws -> KeychainItem? {
		var query = baseQuery(service: service, account: account, accessGroup: accessGroup)
		query[kSecReturnData as String] = true
		query[kSecReturnAttributes as String] = true
		query[kSecMatchLimit as String] = kSecMatchLimitOne
		var result: CFTypeRef?
		let status = SecItemCopyMatching(query as CFDictionary, &result)
		if status == errSecItemNotFound { return nil }
		guard status == errSecSuccess,
			let attributes = result as? [String: Any],
			let data = attributes[kSecValueData as String] as? Data else {
			throw KeychainAccessError(status: status)
		}
		return KeychainItem(data: data, accessGroup: attributes[kSecAttrAccessGroup as String] as? String)
	}

	func addItem(_ data: Data, service: String, account: String, accessGroup: String?) throws {
		var query = baseQuery(service: service, account: account, accessGroup: accessGroup)
		query[kSecValueData as String] = data
		query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
		let status = SecItemAdd(query as CFDictionary, nil)
		guard status == errSecSuccess else { throw KeychainAccessError(status: status) }
	}

	func deleteItems(service: String, account: String, accessGroup: String?) throws {
		let status = SecItemDelete(baseQuery(service: service, account: account, accessGroup: accessGroup) as CFDictionary)
		guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainAccessError(status: status) }
	}

	private func baseQuery(service: String, account: String, accessGroup: String?) -> [String: Any] {
		var query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
		]
		if let accessGroup {
			query[kSecAttrAccessGroup as String] = accessGroup
		}
		return query
	}
}

/// The Pigeon session token, kept in the app group's keychain access group so
/// the share extension can save links. On iOS an app group is also a keychain
/// access group, so no extra entitlement or profile capability is needed.
nonisolated struct SharedSessionKeychain: Sendable {
	static let service = "com.hans.pigeon.reader"
	static let account = "session"

	let keychain: any KeychainItemAccessing
	let accessGroup: String

	init(keychain: any KeychainItemAccessing = SystemKeychain(), accessGroup: String = PigeonSharedData.appGroup) {
		self.keychain = keychain
		self.accessGroup = accessGroup
	}

	/// Reads the shared item. Builds before Read It Later wrote it to the app's
	/// own access group; that item is moved here the first time it is read.
	func load(migratingLegacyItem: Bool = true) throws -> Data? {
		if let shared = try keychain.copyItem(service: Self.service, account: Self.account, accessGroup: accessGroup) {
			return shared.data
		}
		guard migratingLegacyItem,
			let legacy = try keychain.copyItem(service: Self.service, account: Self.account, accessGroup: nil) else {
			return nil
		}
		do {
			try keychain.addItem(legacy.data, service: Self.service, account: Self.account, accessGroup: accessGroup)
		} catch let error as KeychainAccessError where error.isMissingEntitlement {
			// Unsigned simulator builds keep using the private item.
			return legacy.data
		} catch let error as KeychainAccessError where error.status == errSecDuplicateItem {
			// Another reader migrated it first.
		}
		// Delete only the old copy; a nil group would also delete the new one.
		if let legacyGroup = legacy.accessGroup, legacyGroup != accessGroup {
			try? keychain.deleteItems(service: Self.service, account: Self.account, accessGroup: legacyGroup)
		}
		return legacy.data
	}

	func save(_ data: Data) throws {
		try remove()
		do {
			try keychain.addItem(data, service: Self.service, account: Self.account, accessGroup: accessGroup)
		} catch let error as KeychainAccessError where error.isMissingEntitlement {
			try keychain.addItem(data, service: Self.service, account: Self.account, accessGroup: nil)
		}
	}

	func remove() throws {
		try keychain.deleteItems(service: Self.service, account: Self.account, accessGroup: nil)
	}
}

// MARK: - Offline save queue

nonisolated struct PendingSavedLink: Codable, Equatable, Identifiable, Sendable {
	let id: String
	let url: URL
	let title: String?
	let createdAt: Date
}

/// Links saved while the server was unreachable, in the app group so the
/// share extension and the app share one queue. The app sends them on launch
/// and after each sync.
nonisolated enum PendingSavedLinkQueue {
	static let key = "pigeon.pending-saved-links.v1"
	static let limit = 200

	static func all(defaults: UserDefaults = PigeonSharedData.defaults) -> [PendingSavedLink] {
		guard let data = defaults.data(forKey: key),
			let links = try? JSONDecoder().decode([PendingSavedLink].self, from: data) else { return [] }
		return links
	}

	/// Adds a link, or refreshes the title of one already queued.
	@discardableResult
	static func enqueue(
		url: URL,
		title: String?,
		defaults: UserDefaults = PigeonSharedData.defaults,
		now: Date = .now,
	) -> PendingSavedLink? {
		guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host != nil else { return nil }
		var links = all(defaults: defaults)
		let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
		let link = PendingSavedLink(
			id: links.first(where: { $0.url == url })?.id ?? UUID().uuidString.lowercased(),
			url: url,
			title: trimmedTitle?.isEmpty == false ? trimmedTitle : nil,
			createdAt: now,
		)
		links.removeAll { $0.url == url }
		links.append(link)
		if links.count > limit {
			links.removeFirst(links.count - limit)
		}
		write(links, defaults: defaults)
		return link
	}

	static func remove(ids: Set<String>, defaults: UserDefaults = PigeonSharedData.defaults) {
		guard ids.isEmpty == false else { return }
		write(all(defaults: defaults).filter { ids.contains($0.id) == false }, defaults: defaults)
	}

	private static func write(_ links: [PendingSavedLink], defaults: UserDefaults) {
		if links.isEmpty {
			defaults.removeObject(forKey: key)
		} else if let data = try? JSONEncoder().encode(links) {
			defaults.set(data, forKey: key)
		}
	}
}

/// How a failed save should be handled.
nonisolated enum SavedLinkFailure: Equatable, Sendable {
	/// Keep it queued: offline, a server error, or no session yet.
	case retryLater
	/// The server refused the link itself (bad URL, too large). Retrying cannot help.
	case rejected

	static func classify(statusCode: Int?) -> Self {
		guard let statusCode else { return .retryLater }
		return [400, 405, 413, 422].contains(statusCode) ? .rejected : .retryLater
	}
}

// MARK: - Share extension helpers

nonisolated enum SharedLinkClassifier {
	/// Whether a shared URL is probably a feed (or a YouTube channel) rather
	/// than an article. Those offer Add as Feed first.
	static func looksLikeFeed(_ url: URL) -> Bool {
		let host = url.host()?.lowercased() ?? ""
		let path = url.path().lowercased()
		let components = path.split(separator: "/").map(String.init)
		if host.hasSuffix("youtube.com") {
			guard let first = components.first else { return false }
			return first.hasPrefix("@") || ["channel", "c", "user", "feeds"].contains(first)
		}
		if ["xml", "rss", "atom", "rdf"].contains((components.last as NSString?)?.pathExtension ?? "") {
			return true
		}
		if components.contains(where: { ["feed", "feeds", "rss", "atom"].contains($0) }) {
			return true
		}
		if components.last.map({ $0 == "feed.json" || $0 == "index.xml" }) == true {
			return true
		}
		let query = url.query()?.lowercased() ?? ""
		return query.contains("feed=rss") || query.contains("format=rss") || query.contains("feed=atom")
	}

	/// The request the extension sends: the bare link, never page content, so
	/// it stays well inside the extension's memory limit.
	static func saveRequest(baseURL: URL, token: String, url: URL, title: String?) throws -> URLRequest {
		var request = URLRequest(url: baseURL.appending(path: "api/v1/saved"), timeoutInterval: 15)
		request.httpMethod = "POST"
		request.setValue("GoogleLogin auth=pigeon/\(token)", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
		request.setValue("pigeon-reader/1", forHTTPHeaderField: "X-Pigeon-Client")
		var body: [String: String] = ["url": url.absoluteString]
		if let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), title.isEmpty == false {
			body["title"] = String(title.prefix(500))
		}
		request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
		return request
	}
}
