import Foundation

/// Read It Later: links saved into Pigeon's own system feed. The contract is
/// docs/superpowers/plans/2026-11-03-read-it-later-03-core.md.
nonisolated enum SavedItems {
	/// The system feed that holds every saved item.
	static let feedKey = "pigeon:saved"
	static let sourceType = "saved"
	static let title = "Read It Later"
	/// Extraction attempts before the item is reported as failed.
	static let maximumExtractionAttempts = 3

	static func isSavedFeed(feedKey: String?, sourceType: String? = nil) -> Bool {
		feedKey == Self.feedKey || sourceType == Self.sourceType
	}

	/// The Worker accepts only item ids (UUIDs) for `remove_saved`; reader ids
	/// are rowids that SQLite can reuse after a delete.
	static func isRemovableItemID(_ id: String) -> Bool {
		UUID(uuidString: id) != nil
	}
}

nonisolated enum SavedExtractionState: String, Codable, Sendable {
	case pending
	case done
	case failed
}

/// Server metadata that only saved items carry. Kept as one optional value on
/// `Recommendation` so every other article stays exactly as it was.
nonisolated struct SavedArticleMetadata: Codable, Equatable, Hashable, Sendable {
	/// Raw value from the server; unknown future states decode as nil.
	var extractionState: String?
	var publishedAt: Date?
	var imageURL: URL?
	var siteName: String?

	init?(extractionState: String?, publishedAt: Date?, imageURL: URL?, siteName: String?) {
		guard extractionState != nil || publishedAt != nil || imageURL != nil || siteName != nil else { return nil }
		self.extractionState = extractionState
		self.publishedAt = publishedAt
		self.imageURL = imageURL.flatMap(Self.safeWebURL)
		self.siteName = siteName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
	}

	var state: SavedExtractionState? {
		extractionState.flatMap(SavedExtractionState.init(rawValue:))
	}

	/// `existing` with its extraction state replaced, or metadata holding only that state.
	static func with(state: SavedExtractionState, from existing: SavedArticleMetadata?) -> SavedArticleMetadata {
		var metadata = existing ?? SavedArticleMetadata(stateOnly: state)
		metadata.extractionState = state.rawValue
		return metadata
	}

	private init(stateOnly state: SavedExtractionState) {
		extractionState = state.rawValue
	}

	/// The Worker sends ISO 8601 UTC, with or without fractional seconds.
	static func parseDate(_ value: String) -> Date? {
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		if let date = formatter.date(from: value) { return date }
		formatter.formatOptions = [.withInternetDateTime]
		return formatter.date(from: value)
	}

	static func safeWebURL(_ url: URL) -> URL? {
		guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host != nil else {
			return nil
		}
		return url
	}
}

extension Recommendation {
	/// True for items in the Read It Later feed. They never appear in Today,
	/// Unread, folders or For You.
	nonisolated var isSaved: Bool {
		feedKey == SavedItems.feedKey || saved?.extractionState != nil
	}

	/// A readable body always wins: a stale sync copy can still say pending
	/// after this device uploaded the extraction.
	nonisolated var savedState: SavedExtractionState? {
		guard isSaved else { return nil }
		if hasReadableHTML { return .done }
		return saved?.state ?? .pending
	}

	nonisolated var isSavedVideo: Bool {
		length?.isVideo == true || YouTubeVideo(url: safeOriginalURL) != nil
	}

	/// The saved item's thumbnail: its lead image, else the video's poster frame.
	nonisolated var savedThumbnailURL: URL? {
		if let imageURL = saved?.imageURL { return imageURL }
		guard let video = YouTubeVideo(url: safeOriginalURL) else { return nil }
		return URL(string: "https://i.ytimg.com/vi/\(video.videoID)/hqdefault.jpg")
	}

	/// The site or channel shown on the saved list.
	nonisolated var savedSourceName: String {
		if let siteName = saved?.siteName { return siteName }
		if let host = safeOriginalURL?.host() {
			return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
		}
		return source
	}
}

extension Recommendation {
	nonisolated func updatingSaved(
		title: String? = nil,
		html: String? = nil,
		text: String?? = nil,
		author: String?? = nil,
		receivedAt: Date? = nil,
		isRead: Bool? = nil,
		length: ArticleLength?? = nil,
		saved: SavedArticleMetadata?? = nil,
	) -> Recommendation {
		Recommendation(
			id: id,
			readerId: readerId,
			feedKey: feedKey,
			source: source,
			author: author ?? self.author,
			title: title ?? self.title,
			html: html ?? self.html,
			text: text ?? self.text,
			originalURL: originalURL,
			receivedAt: receivedAt ?? self.receivedAt,
			isRead: isRead ?? self.isRead,
			isStarred: isStarred,
			score: score,
			confidence: confidence,
			sampleCount: sampleCount,
			explanation: explanation,
			learningState: learningState,
			isBodyPruned: html == nil ? isBodyPruned : nil,
			contentVersion: contentVersion,
			isPaywalled: isPaywalled,
			length: length ?? self.length,
			saved: saved ?? self.saved,
		)
	}

	/// The local copy after this device uploaded an extraction.
	nonisolated func applyingSavedContent(_ content: SavedItemContent) -> Recommendation {
		let trimmedTitle = content.title?.trimmingCharacters(in: .whitespacesAndNewlines)
		var metadata = SavedArticleMetadata.with(state: .done, from: saved)
		if metadata.imageURL == nil,
			let image = content.image.flatMap(URL.init(string:)).flatMap(SavedArticleMetadata.safeWebURL) {
			metadata.imageURL = image
		}
		if let site = content.site?.trimmingCharacters(in: .whitespacesAndNewlines), site.isEmpty == false {
			metadata.siteName = site
		}
		if let published = content.published.flatMap(SavedArticleMetadata.parseDate) {
			metadata.publishedAt = published
		}
		var updatedLength = length ?? ArticleLength(wordCount: nil, mediaKind: content.mediaKind ?? "text", durationSeconds: nil)
		if let wordCount = content.wordCount { updatedLength?.wordCount = wordCount }
		if let mediaKind = content.mediaKind { updatedLength?.mediaKind = mediaKind }
		return updatingSaved(
			title: trimmedTitle?.isEmpty == false ? trimmedTitle : nil,
			html: content.html,
			text: content.html == nil ? .none : .some(content.text),
			author: content.author.map { Optional($0) },
			length: .some(updatedLength),
			saved: .some(metadata),
		)
	}

	/// What the list shows for a link just saved here, until sync brings the
	/// server's row. The title follows the Worker's fallback (host + path).
	nonisolated static func savedPlaceholder(
		response: SavedItemResponse,
		title: String?,
		receivedAt: Date,
		state: SavedExtractionState,
	) -> Recommendation {
		let url = URL(string: response.url)
		let trimmedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
		let fallbackTitle = url.map { url in
			let host = (url.host() ?? "").replacingOccurrences(of: "www.", with: "", options: .anchored)
			let path = url.path() == "/" ? "" : url.path()
			return host + path
		} ?? response.url
		let isVideo = YouTubeVideo(url: url) != nil
		return Recommendation(
			id: response.id,
			readerId: response.readerId,
			feedKey: SavedItems.feedKey,
			source: SavedItems.title,
			title: trimmedTitle?.isEmpty == false ? trimmedTitle ?? fallbackTitle : fallbackTitle,
			html: "",
			text: nil,
			originalURL: url,
			receivedAt: receivedAt,
			isRead: false,
			isStarred: false,
			score: 0,
			confidence: 0,
			sampleCount: 0,
			explanation: "Saved to Read It Later",
			learningState: "Saved",
			length: isVideo ? ArticleLength(wordCount: nil, mediaKind: "video", durationSeconds: nil) : nil,
			saved: SavedArticleMetadata.with(state: state, from: nil),
		)
	}
}

// MARK: - Save API

nonisolated struct SaveLinkRequest: Encodable, Equatable, Sendable {
	let url: String
	let title: String?
}

/// The extraction uploaded with `PUT /api/v1/saved/:id/content`.
nonisolated struct SavedItemContent: Encodable, Equatable, Sendable {
	var html: String?
	var text: String?
	var title: String?
	var wordCount: Int?
	var author: String?
	/// ISO 8601; the Worker normalizes to UTC and drops relative strings.
	var published: String?
	var image: String?
	var site: String?
	var mediaKind: String?
	var durationSeconds: Int?

	init(
		html: String? = nil,
		text: String? = nil,
		title: String? = nil,
		wordCount: Int? = nil,
		author: String? = nil,
		published: String? = nil,
		image: String? = nil,
		site: String? = nil,
		mediaKind: String? = nil,
		durationSeconds: Int? = nil,
	) {
		self.html = html
		self.text = text
		self.title = title
		self.wordCount = wordCount
		self.author = author
		self.published = published
		self.image = image
		self.site = site
		self.mediaKind = mediaKind
		self.durationSeconds = durationSeconds
	}

	/// A Defuddle (or Readability) extraction of a text page.
	init(document: ReaderViewDocument) {
		self.init(
			html: document.contentHTML,
			text: document.textContent,
			title: document.title,
			wordCount: document.wordCount,
			author: document.byline,
			published: document.publishedAt.map { $0.formatted(.iso8601) },
			image: document.leadImageURL?.absoluteString,
			site: document.siteName,
			mediaKind: "text",
		)
	}
}

nonisolated struct SavedExtractionFailure: Encodable, Sendable {
	let failed = true
}

nonisolated struct SavedItemResponse: Decodable, Equatable, Sendable {
	let id: String
	let readerId: String
	let url: String
	let state: String
	var created: Bool? = nil
	var updated: Bool? = nil
	var contentTooLarge: Bool? = nil

	var extractionState: SavedExtractionState? {
		SavedExtractionState(rawValue: state)
	}
}

// MARK: - List filters and sort

nonisolated enum SavedKindFilter: String, CaseIterable, Identifiable, Sendable {
	case all
	case text
	case video

	var id: Self { self }

	var title: String {
		switch self {
		case .all: "All"
		case .text: "Text"
		case .video: "Video"
		}
	}
}

nonisolated enum SavedLengthFilter: String, CaseIterable, Identifiable, Sendable {
	case any
	case short
	case medium
	case long

	var id: Self { self }

	var title: String {
		switch self {
		case .any: "Any Length"
		case .short: "Under 5 min"
		case .medium: "5–15 min"
		case .long: "15+ min"
		}
	}

	/// Unknown lengths appear only under Any.
	func includes(minutes: Int?) -> Bool {
		switch self {
		case .any: true
		case .short: minutes.map { $0 < 5 } ?? false
		case .medium: minutes.map { (5..<15).contains($0) } ?? false
		case .long: minutes.map { $0 >= 15 } ?? false
		}
	}
}

/// The Read It Later filters beyond Unread/Archive (which reuse the
/// collection's read filter), persisted on this device.
nonisolated struct SavedListFilter: Equatable, Sendable {
	var kind: SavedKindFilter = .all
	var length: SavedLengthFilter = .any

	static let kindKey = "pigeon.saved.filter.kind.v1"
	static let lengthKey = "pigeon.saved.filter.length.v1"

	static func load(from defaults: UserDefaults) -> Self {
		Self(
			kind: defaults.string(forKey: kindKey).flatMap(SavedKindFilter.init(rawValue:)) ?? .all,
			length: defaults.string(forKey: lengthKey).flatMap(SavedLengthFilter.init(rawValue:)) ?? .any,
		)
	}

	func save(to defaults: UserDefaults) {
		defaults.set(kind.rawValue, forKey: Self.kindKey)
		defaults.set(length.rawValue, forKey: Self.lengthKey)
	}

	var isDefault: Bool { self == Self() }

	func includes(_ article: Recommendation, minutes: Int?) -> Bool {
		switch kind {
		case .all: break
		case .text: if article.isSavedVideo { return false }
		case .video: if article.isSavedVideo == false { return false }
		}
		return length.includes(minutes: minutes)
	}
}

nonisolated enum SavedLength {
	/// Whole minutes: a video's duration, else words at the app's reading
	/// speed. Nil when nothing is known.
	static func minutes(wordCount: Int?, estimatedWordCount: Int?, mediaKind: String?, durationSeconds: Int?) -> Int? {
		if mediaKind == "video" {
			guard let durationSeconds, durationSeconds > 0 else { return nil }
			return max(1, (durationSeconds + 59) / 60)
		}
		guard let words = wordCount ?? estimatedWordCount, words > 0 else { return nil }
		return max(1, (words + ReadingLength.wordsPerMinute - 1) / ReadingLength.wordsPerMinute)
	}

	/// Saved pages carry the extractor's word count, so filters and sorts use
	/// the stored length only and agree with each other everywhere.
	static func minutes(for article: Recommendation) -> Int? {
		let isVideo = article.isSavedVideo
		return minutes(
			wordCount: article.length?.wordCount,
			estimatedWordCount: nil,
			mediaKind: isVideo ? "video" : article.length?.mediaKind,
			durationSeconds: article.length?.durationSeconds,
		)
	}

	/// Shortest/longest order: known lengths first, then newest saved.
	static func areInIncreasingOrder(
		_ left: (minutes: Int?, article: Recommendation),
		_ right: (minutes: Int?, article: Recommendation),
		longestFirst: Bool,
	) -> Bool {
		switch (left.minutes, right.minutes) {
		case let (leftMinutes?, rightMinutes?) where leftMinutes != rightMinutes:
			return longestFirst ? leftMinutes > rightMinutes : leftMinutes < rightMinutes
		case (.some, nil):
			return true
		case (nil, .some):
			return false
		default:
			if left.article.receivedAt != right.article.receivedAt {
				return left.article.receivedAt > right.article.receivedAt
			}
			return left.article.id < right.article.id
		}
	}
}

private extension String {
	nonisolated var nilIfEmpty: String? { isEmpty ? nil : self }
}
