import Foundation

nonisolated struct Recommendation: Codable, Equatable, Hashable, Identifiable, Sendable {
	let id: String
	let readerId: String
	let feedKey: String
	let source: String
	var author: String? = nil
	let title: String
	let html: String
	let text: String?
	let originalURL: URL?
	let receivedAt: Date
	var isRead: Bool
	var isStarred: Bool
	let score: Int
	let confidence: Double
	let sampleCount: Int
	let explanation: String
	let learningState: String

	var safeOriginalURL: URL? {
		guard let originalURL, let scheme = originalURL.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
			return nil
		}
		return originalURL
	}

	/// Visible byline, ignoring blank GReader authors and names that only repeat the feed.
	var displayAuthor: String? {
		Self.displayAuthor(author, source: source)
	}

	static func displayAuthor(_ author: String?, source: String) -> String? {
		guard let author else {
			return nil
		}
		let trimmed = author.trimmingCharacters(in: .whitespacesAndNewlines)
		guard trimmed.isEmpty == false else {
			return nil
		}
		let trimmedSource = source.trimmingCharacters(in: .whitespacesAndNewlines)
		if trimmed.caseInsensitiveCompare(trimmedSource) == .orderedSame {
			return nil
		}
		return trimmed
	}
}
