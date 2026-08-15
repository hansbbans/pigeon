import Foundation

enum ReaderViewLoadState: Equatable, Sendable {
	case idle
	case loading
	case loaded
	case unavailable
	case failed(String)
	case fallback(String)
}
