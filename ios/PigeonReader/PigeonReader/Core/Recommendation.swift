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
	/// Server reading-length metadata; nil for older servers and caches.
	var length: ArticleLength? = nil
	/// Read It Later metadata; nil for every article outside the saved feed.
	var saved: SavedArticleMetadata? = nil
	/// True once the server holds a YouTube transcript for this item; nil when unknown.
	var hasTranscript: Bool? = nil

	init(
		id: String,
		readerId: String,
		feedKey: String,
		source: String,
		author: String? = nil,
		title: String,
		html: String,
		text: String?,
		originalURL: URL?,
		receivedAt: Date,
		isRead: Bool,
		isStarred: Bool,
		score: Int,
		confidence: Double,
		sampleCount: Int,
		explanation: String,
		learningState: String,
		isBodyPruned: Bool? = nil,
		contentVersion: String? = nil,
		isPaywalled: Bool? = nil,
		length: ArticleLength? = nil,
		saved: SavedArticleMetadata? = nil,
		hasTranscript: Bool? = nil,
	) {
		self.id = id
		self.readerId = readerId
		self.feedKey = feedKey
		self.source = source
		self.author = author
		self.title = title
		self.html = html
		self.text = text
		self.originalURL = originalURL
		self.receivedAt = receivedAt
		self.isRead = isRead
		self.isStarred = isStarred
		self.score = score
		self.confidence = confidence
		self.sampleCount = sampleCount
		self.explanation = explanation
		self.learningState = learningState
		self.isBodyPruned = isBodyPruned
		self.contentVersion = contentVersion
		self.isPaywalled = isPaywalled
		self.length = length
		self.saved = saved
		self.hasTranscript = hasTranscript
	}

	private enum CodingKeys: String, CodingKey {
		case id, readerId, feedKey, source, author, title, html, text, originalURL, receivedAt
		case isRead, isStarred, score, confidence, sampleCount, explanation, learningState
		case isBodyPruned, contentVersion, isPaywalled, length, saved, hasTranscript
		case wordCount, mediaKind, durationSeconds
	}

	init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		id = try container.decode(String.self, forKey: .id)
		readerId = try container.decode(String.self, forKey: .readerId)
		feedKey = try container.decode(String.self, forKey: .feedKey)
		source = try container.decode(String.self, forKey: .source)
		author = try container.decodeIfPresent(String.self, forKey: .author)
		title = try container.decode(String.self, forKey: .title)
		html = try container.decode(String.self, forKey: .html)
		text = try container.decodeIfPresent(String.self, forKey: .text)
		originalURL = try container.decodeIfPresent(URL.self, forKey: .originalURL)
		receivedAt = try container.decode(Date.self, forKey: .receivedAt)
		isRead = try container.decode(Bool.self, forKey: .isRead)
		isStarred = try container.decode(Bool.self, forKey: .isStarred)
		score = try container.decode(Int.self, forKey: .score)
		confidence = try container.decode(Double.self, forKey: .confidence)
		sampleCount = try container.decode(Int.self, forKey: .sampleCount)
		explanation = try container.decode(String.self, forKey: .explanation)
		learningState = try container.decode(String.self, forKey: .learningState)
		isBodyPruned = try container.decodeIfPresent(Bool.self, forKey: .isBodyPruned)
		contentVersion = try container.decodeIfPresent(String.self, forKey: .contentVersion)
		isPaywalled = try container.decodeIfPresent(Bool.self, forKey: .isPaywalled)
		if let nestedLength = try container.decodeIfPresent(ArticleLength.self, forKey: .length) {
			length = nestedLength
		} else {
			let wordCount = try container.decodeIfPresent(Int.self, forKey: .wordCount)
			let mediaKind = try container.decodeIfPresent(String.self, forKey: .mediaKind)
			let durationSeconds = try container.decodeIfPresent(Int.self, forKey: .durationSeconds)
			length = ArticleLength(wordCount: wordCount, mediaKind: mediaKind, durationSeconds: durationSeconds)
		}
		saved = try container.decodeIfPresent(SavedArticleMetadata.self, forKey: .saved)
		hasTranscript = try container.decodeIfPresent(Bool.self, forKey: .hasTranscript)
	}

	func encode(to encoder: Encoder) throws {
		var container = encoder.container(keyedBy: CodingKeys.self)
		try container.encode(id, forKey: .id)
		try container.encode(readerId, forKey: .readerId)
		try container.encode(feedKey, forKey: .feedKey)
		try container.encode(source, forKey: .source)
		try container.encodeIfPresent(author, forKey: .author)
		try container.encode(title, forKey: .title)
		try container.encode(html, forKey: .html)
		try container.encodeIfPresent(text, forKey: .text)
		try container.encodeIfPresent(originalURL, forKey: .originalURL)
		try container.encode(receivedAt, forKey: .receivedAt)
		try container.encode(isRead, forKey: .isRead)
		try container.encode(isStarred, forKey: .isStarred)
		try container.encode(score, forKey: .score)
		try container.encode(confidence, forKey: .confidence)
		try container.encode(sampleCount, forKey: .sampleCount)
		try container.encode(explanation, forKey: .explanation)
		try container.encode(learningState, forKey: .learningState)
		try container.encodeIfPresent(isBodyPruned, forKey: .isBodyPruned)
		try container.encodeIfPresent(contentVersion, forKey: .contentVersion)
		try container.encodeIfPresent(isPaywalled, forKey: .isPaywalled)
		try container.encodeIfPresent(length, forKey: .length)
		try container.encodeIfPresent(saved, forKey: .saved)
		try container.encodeIfPresent(hasTranscript, forKey: .hasTranscript)
	}

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
		replacing(html: html, text: text, receivedAt: receivedAt, isBodyPruned: isBodyPruned, isPaywalled: isPaywalled)
	}

	func replacingReceivedAt(_ receivedAt: Date) -> Recommendation {
		replacing(html: html, text: text, receivedAt: receivedAt, isBodyPruned: isBodyPruned, isPaywalled: isPaywalled)
	}

	private func replacing(html: String, text: String?, receivedAt: Date, isBodyPruned: Bool?, isPaywalled: Bool?) -> Recommendation {
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
			length: length,
			saved: saved,
			hasTranscript: hasTranscript,
		)
	}
}
