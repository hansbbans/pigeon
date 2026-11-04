import Foundation

/// What happened to a Read It Later save made inside the app.
enum SaveForLaterOutcome: Equatable, Sendable {
	/// The server has the link.
	case saved
	/// The server was unreachable; the link is queued and sent after the next sync.
	case queued
	/// The same link is already being saved.
	case alreadySaving

	var confirmationMessage: String {
		switch self {
		case .saved: "Saved to Read It Later"
		case .queued: "Saved, will sync"
		case .alreadySaving: "Already saving this link…"
		}
	}

	var isSuccess: Bool { self != .alreadySaving }
}

/// Raised when the server refused the link itself.
struct SaveForLaterError: Error, LocalizedError, Equatable, Sendable {
	let message: String

	var errorDescription: String? { message }
}
