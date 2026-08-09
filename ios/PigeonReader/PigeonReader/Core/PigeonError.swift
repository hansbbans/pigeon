import Foundation

enum PigeonError: Error, LocalizedError, Sendable {
	case invalidServerURL
	case authenticationFailed
	case server(statusCode: Int, message: String)
	case invalidResponse
	case keychain(status: Int32)

	var errorDescription: String? {
		switch self {
		case .invalidServerURL:
			"Enter a valid HTTPS server URL. Pigeon never sends credentials over an unencrypted connection."
		case .authenticationFailed:
			"Pigeon could not authenticate with that password."
		case let .server(statusCode, message):
			message.isEmpty ? "Pigeon returned an error (\(statusCode))." : message
		case .invalidResponse:
			"Pigeon returned an unexpected response."
		case let .keychain(status):
			"The session could not be saved securely (Keychain error \(status))."
		}
	}
}
