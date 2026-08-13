import Foundation

enum ReadwiseSaveError: Error, LocalizedError, Equatable, Sendable {
	case missingToken
	case authenticationFailed
	case server(statusCode: Int)
	case invalidResponse
	case network

	var errorDescription: String? {
		switch self {
		case .missingToken:
			"Add a Readwise access token in Settings before saving links."
		case .authenticationFailed:
			"Readwise rejected the saved token. Update it in Settings and try again."
		case let .server(statusCode):
			"Readwise returned an error (status \(statusCode)). Try again."
		case .invalidResponse:
			"Readwise returned an unexpected response. Try again."
		case .network:
			"Readwise could not be reached. Check your connection and try again."
		}
	}
}
