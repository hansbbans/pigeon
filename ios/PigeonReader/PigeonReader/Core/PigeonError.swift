import Foundation

enum PigeonError: Error, LocalizedError, Sendable {
	case invalidServerURL
	case authenticationFailed
	case server(statusCode: Int, message: String)
	case invalidResponse
	case keychain(status: Int32)
	case invalidReadwiseToken
	case readwiseKeychain(status: Int32)

	var errorDescription: String? {
		switch self {
		case .invalidServerURL:
			"Enter a valid HTTPS server URL. Pigeon never sends credentials over an unencrypted connection."
		case .authenticationFailed:
			"Pigeon could not authenticate with that password."
		case let .server(statusCode, message):
			Self.serverDescription(statusCode: statusCode, message: message)
		case .invalidResponse:
			"Pigeon returned an unexpected response."
		case let .keychain(status):
			"The session could not be saved securely (Keychain error \(status))."
		case .invalidReadwiseToken:
			"Enter a non-empty Readwise access token."
		case let .readwiseKeychain(status):
			"The Readwise token could not be saved securely (Keychain error \(status))."
		}
	}

	private static func serverDescription(statusCode: Int, message: String) -> String {
		let fallback = "Pigeon returned an error (\(statusCode))."
		let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
		guard trimmed.isEmpty == false else {
			return fallback
		}

		if let data = trimmed.data(using: .utf8),
			let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
			let errorCode = payload["error_code"] as? Int
			let errorName = payload["error_name"] as? String
			if errorCode == 1102 || errorName == "worker_exceeded_resources" {
				let rayID = payload["ray_id"] as? String
				let reference = rayID.map { " Reference: \($0)." } ?? ""
				return "Pigeon could not finish loading because the server exceeded a resource limit (Cloudflare 1102).\(reference)"
			}

			if let title = payload["title"] as? String, title.isEmpty == false {
				return "\(title) (\(statusCode))."
			}
			return fallback
		}

		guard trimmed.count <= 240, trimmed.contains("<") == false else {
			return fallback
		}
		return trimmed
	}
}
