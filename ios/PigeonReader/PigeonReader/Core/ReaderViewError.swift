import Foundation

enum ReaderViewError: Error, LocalizedError, Equatable, Sendable {
	case invalidURL
	case invalidResponse
	case httpStatus(Int)
	case responseTooLarge
	case unsupportedContent
	case readabilityUnavailable
	case extractionFailed

	var errorDescription: String? {
		switch self {
		case .invalidURL:
			"Reader View needs a valid original web address."
		case .invalidResponse:
			"The original page returned an unexpected response."
		case let .httpStatus(status) where status == 404:
			"The original page was not found (HTTP 404). The web version of this newsletter may have expired or moved."
		case let .httpStatus(status):
			"The original page could not be loaded (HTTP \(status))."
		case .responseTooLarge:
			"The original page is too large to prepare safely."
		case .unsupportedContent:
			"The original address did not return an HTML page."
		case .readabilityUnavailable:
			"Reader View is unavailable in this build."
		case .extractionFailed:
			"Pigeon could not find a readable article on that page."
		}
	}
}
