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

	var hasReadableHTML: Bool {
		html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
	}

	func replacingHTML(_ html: String) -> Recommendation {
		Recommendation(
			id: id,
			readerId: readerId,
			feedKey: feedKey,
			source: source,
			author: author,
			title: title,
			html: html,
			text: text,
			originalURL: originalURL,
			receivedAt: receivedAt,
			isRead: isRead,
			isStarred: isStarred,
			score: score,
			confidence: confidence,
			sampleCount: sampleCount,
			explanation: explanation,
			learningState: learningState,
		)
	}
}
