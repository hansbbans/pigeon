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
	var isBodyPruned: Bool? = nil
	/// Server version of the `html` currently held; nil when unknown (legacy servers or caches).
	var contentVersion: String? = nil
	/// True when the server saw only the publisher's paywalled teaser of this article.
	var isPaywalled: Bool? = nil

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

	var hasReadableHTML: Bool {
		html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
	}

	func replacingHTML(_ html: String) -> Recommendation {
		replacingBody(html: html, text: text, isBodyPruned: isBodyPruned, isPaywalled: isPaywalled)
	}

	/// The paywall flag describes the body, so callers pass the flag of whichever article supplied it.
	func replacingBody(html: String, text: String?, isBodyPruned: Bool?, isPaywalled: Bool?) -> Recommendation {
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
			isBodyPruned: isBodyPruned,
			contentVersion: contentVersion,
			isPaywalled: isPaywalled,
		)
	}
}
