import CryptoKit
import Foundation

struct PigeonSession: Codable, Equatable, Sendable {
	let baseURL: URL
	let token: String
}

extension PigeonSession {
	/// Returns an opaque, stable identity for session-scoped local preferences.
	///
	/// The ClientLogin token is the only account boundary available to this app. Pigeon's
	/// Worker derives that token deterministically from the fixed account password on each
	/// login, rather than issuing a rotating nonce. Hashing it together with the normalized
	/// server URL keeps credentials out of UserDefaults keys while keeping the same account
	/// stable across reconnects.
	var articleFilterStorageIdentity: String {
		let material = "\(normalizedArticleFilterServerURL)\u{0}\(token)"
		let digest = SHA256.hash(data: Data(material.utf8))
		return digest.reduce(into: "") { result, byte in
			let hex = String(byte, radix: 16)
			if hex.count == 1 {
				result.append("0")
			}
			result.append(contentsOf: hex)
		}
	}

	private var normalizedArticleFilterServerURL: String {
		var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
		if let scheme = components?.scheme {
			components?.scheme = scheme.lowercased()
		}
		if let host = components?.host {
			components?.host = host.lowercased()
		}
		components?.user = nil
		components?.password = nil
		components?.fragment = nil
		components?.query = nil
		let trimmedPath = (components?.path ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
		components?.path = trimmedPath.isEmpty ? "" : "/\(trimmedPath)"
		return components?.string ?? baseURL.absoluteString
	}
}
