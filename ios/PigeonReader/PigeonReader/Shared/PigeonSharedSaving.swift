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
	/// Any failure to use the group (an unsigned build has no entitlement for
	/// it) falls back to the private item, so migration can never sign anyone out.
	func load(migratingLegacyItem: Bool = true) throws -> Data? {
		if let shared = try? keychain.copyItem(service: Self.service, account: Self.account, accessGroup: accessGroup) {
			return shared.data
		}
		guard migratingLegacyItem,
			let legacy = try keychain.copyItem(service: Self.service, account: Self.account, accessGroup: nil) else {
			return nil
		}
		guard legacy.accessGroup != accessGroup else { return legacy.data }
		do {
			try keychain.addItem(legacy.data, service: Self.service, account: Self.account, accessGroup: accessGroup)
		} catch let error as KeychainAccessError where error.status == errSecDuplicateItem {
			// Another reader migrated it first.
		} catch {
			// Keep using the private item; the next launch tries again.
			return legacy.data
		}
		// Delete only the old copy; a nil group would also delete the new one.
		if let legacyGroup = legacy.accessGroup {
			try? keychain.deleteItems(service: Self.service, account: Self.account, accessGroup: legacyGroup)
		}
		return legacy.data
	}

	func save(_ data: Data) throws {
		try remove()
		do {
			try keychain.addItem(data, service: Self.service, account: Self.account, accessGroup: accessGroup)
		} catch {
			// Without the group the share extension queues its saves instead;
			// the session itself must still be kept.
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

/// Links saved while the server was unreachable, kept in the app group so the
/// share extension and the app share one queue. The app sends them on launch
/// and after each sync.
///
/// Two processes write it, so there is no shared list to read, modify and
/// write back: each link is its own file, named after its URL and written
/// atomically, and a sent link is removed by name. A link added by the share
/// extension while the app is flushing can never be overwritten or dropped.
nonisolated struct PendingSavedLinkQueue: Sendable {
	static let limit = 200
	static let directoryName = "PendingSavedLinks"

	let directory: URL

	init(directory: URL) {
		self.directory = directory
	}

	/// The app group container's queue (the app's own Library when the group is
	/// unavailable, as in unsigned simulator builds).
	static var shared: PendingSavedLinkQueue {
		let base = sharedContainerURL
			?? FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
		return PendingSavedLinkQueue(directory: base.appending(path: directoryName, directoryHint: .isDirectory))
	}

	/// Nil when this process has no App Group (unsigned simulator, a profile
	/// without `group.com.hans.pigeon.reader`). The share extension must not
	/// treat a write to its private Library as a successful handoff: the app
	/// will never see that file.
	static var sharedContainerURL: URL? {
		FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: PigeonSharedData.appGroup)
	}

	static var hasSharedContainer: Bool { sharedContainerURL != nil }

	func all() -> [PendingSavedLink] {
		let files = (try? FileManager.default.contentsOfDirectory(
			at: directory,
			includingPropertiesForKeys: nil,
			options: [.skipsHiddenFiles],
		)) ?? []
		let decoder = JSONDecoder()
		return files
			.filter { $0.pathExtension == "json" }
			.compactMap { try? decoder.decode(PendingSavedLink.self, from: Data(contentsOf: $0)) }
			.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
	}

	/// Adds a link, or refreshes the title of one already queued.
	@discardableResult
	func enqueue(url: URL, title: String?, now: Date = .now) -> PendingSavedLink? {
		guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), url.host != nil else { return nil }
		let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
		let link = PendingSavedLink(
			id: Self.fileStem(for: url),
			url: url,
			title: trimmedTitle?.isEmpty == false ? trimmedTitle : nil,
			createdAt: now,
		)
		do {
			try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
			let data = try JSONEncoder().encode(link)
			try data.write(to: fileURL(for: link.id), options: [.atomic])
		} catch {
			return nil
		}
		trimToLimit()
		return link
	}

	func remove(ids: Set<String>) {
		for id in ids {
			try? FileManager.default.removeItem(at: fileURL(for: id))
		}
	}

	private func trimToLimit() {
		let links = all()
		guard links.count > Self.limit else { return }
		remove(ids: Set(links.prefix(links.count - Self.limit).map(\.id)))
	}

	private func fileURL(for id: String) -> URL {
		directory.appending(path: "\(id).json", directoryHint: .notDirectory)
	}

	/// One file per URL: a repeated save of the same link replaces its entry.
	static func fileStem(for url: URL) -> String {
		// FNV-1a over the URL bytes, twice with different seeds: stable across
		// processes and launches, unlike Hasher.
		func fnv(_ seed: UInt64) -> UInt64 {
			url.absoluteString.utf8.reduce(seed) { ($0 ^ UInt64($1)) &* 0x100000001b3 }
		}
		return String(format: "%016llx%016llx", fnv(0xcbf29ce484222325), fnv(0x84222325cbf29ce4))
	}
}

/// How a failed save should be handled.
nonisolated enum SavedLinkFailure: Equatable, Sendable {
	/// Keep it queued: offline, a server error, or no valid session yet.
	case retryLater
	/// The server refused the link itself (bad URL, too large). Retrying cannot help.
	case rejected

	static func classify(statusCode: Int?) -> Self {
		guard let statusCode else { return .retryLater }
		return [400, 405, 413, 422].contains(statusCode) ? .rejected : .retryLater
	}

	/// What the share extension shows for a `.rejected` link: the server's own
	/// reason when it sent one.
	static func rejectionMessage(body: Data?) -> String {
		serverMessage(from: body) ?? "Pigeon can’t save this kind of link."
	}

	private static func serverMessage(from data: Data?) -> String? {
		guard let data,
			let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
			let message = object["error"] as? String else {
			return nil
		}
		let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
		return trimmed.isEmpty ? nil : String(trimmed.prefix(200))
	}
}

// MARK: - Share extension helpers

/// One http(s) link taken from a share-sheet payload. Safari, Messages, and
/// many other apps do not hand over a `URL`: they register a string, an
/// attributed string, or put the address in the `NSExtensionItem` text.
nonisolated enum SharedShareItem {
	struct Link: Equatable, Sendable {
		let url: URL
		let title: String?
	}

	static func isWebURL(_ url: URL) -> Bool {
		guard url.isFileURL == false, url.user == nil, url.password == nil, url.host != nil else { return false }
		guard let scheme = url.scheme?.lowercased() else { return false }
		return scheme == "http" || scheme == "https"
	}

	static func normalizedTitle(_ raw: String?) -> String? {
		let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return trimmed.isEmpty ? nil : String(trimmed.prefix(500))
	}

	/// Coerces whatever `NSItemProvider.loadItem` actually returned. Safari's
	/// `public.url` can be a string; Messages' `public.plain-text` is often an
	/// `NSAttributedString`. (`as? URL` and `as? String` also bridge `NSURL`
	/// and `NSString`.)
	static func webURL(from payload: Any) -> URL? {
		if let url = payload as? URL { return isWebURL(url) ? url : nil }
		if let string = payload as? String { return firstWebURL(in: string) }
		if let attributed = payload as? NSAttributedString { return firstWebURL(in: attributed.string) }
		if let data = payload as? Data, let string = String(data: data, encoding: .utf8) {
			return firstWebURL(in: string)
		}
		return nil
	}

	/// Title and URL from the item's own text fields, for items whose
	/// attachments carry no usable URL or text.
	static func link(fromItemText title: String?, contentText: String?) -> Link? {
		if let url = firstWebURL(in: contentText ?? "") {
			return Link(url: url, title: normalizedTitle(title))
		}
		if let url = firstWebURL(in: title ?? "") {
			return Link(url: url, title: nil)
		}
		return nil
	}

	/// Messages and other apps often share a sentence with a link in it.
	static func firstWebURL(in text: String) -> URL? {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.isEmpty { return nil }
		// URL(string:) percent-encodes spaces, so only a single token can be the
		// whole link; anything longer goes through the link detector.
		if trimmed.contains(where: \.isWhitespace) == false, let url = URL(string: trimmed), isWebURL(url) {
			return url
		}
		guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
			return nil
		}
		let range = NSRange(trimmed.startIndex..., in: trimmed)
		return detector.matches(in: trimmed, range: range)
			.compactMap(\.url)
			.first { isWebURL($0) }
	}
}

/// Whether the share extension may claim a queued save. A write to the
/// extension's private Library is not a handoff: the app never reads it.
nonisolated enum SharedShareHandoff: Equatable, Sendable {
	/// In the app group queue. The app sends it on its next launch or sync,
	/// after sign-in when `needsSignIn`.
	case queued(needsSignIn: Bool)
	case rejected(String)

	static func queue(hasSharedContainer: Bool, enqueued: Bool, needsSignIn: Bool) -> Self {
		guard hasSharedContainer else {
			return .rejected(
				needsSignIn
					? "Open Pigeon and sign in, then try again."
					: "Pigeon couldn’t save this link. Open the app and try again.",
			)
		}
		// The URL was already checked, so a failed enqueue is a write failure.
		guard enqueued else { return .rejected("Pigeon couldn’t save this link. Try again.") }
		return .queued(needsSignIn: needsSignIn)
	}
}

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
