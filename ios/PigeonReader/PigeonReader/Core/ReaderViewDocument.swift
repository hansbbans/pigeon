import Foundation

enum ReaderViewExtractorKind: String, Sendable {
	case defuddle
	case readability
}

struct ReaderViewDocument: Equatable, Sendable {
	let title: String?
	let byline: String?
	let excerpt: String?
	let contentHTML: String
	let leadImageURL: URL?
	let wordCount: Int?
	let publishedAt: Date?
	let siteName: String?
	let extractor: ReaderViewExtractorKind

	init(
		title: String? = nil,
		byline: String? = nil,
		excerpt: String? = nil,
		contentHTML: String,
		leadImageURL: URL? = nil,
		wordCount: Int? = nil,
		publishedAt: Date? = nil,
		siteName: String? = nil,
		extractor: ReaderViewExtractorKind = .readability,
	) throws {
		let trimmedContent = contentHTML.trimmingCharacters(in: .whitespacesAndNewlines)
		guard trimmedContent.isEmpty == false else {
			throw ReaderViewError.extractionFailed
		}
		self.title = title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
		self.byline = byline?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
		self.excerpt = excerpt?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
		self.contentHTML = trimmedContent
		self.leadImageURL = leadImageURL.flatMap(Self.safeWebURL)
		self.wordCount = wordCount.flatMap { $0 >= 0 ? $0 : nil }
		self.publishedAt = publishedAt
		self.siteName = siteName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
		self.extractor = extractor
	}

	init(payload: [String: Any]) throws {
		let content = payload["content"] as? String ?? ""
		let leadImageURL = (payload["leadImageURL"] as? String).flatMap(URL.init(string:))
		try self.init(
			title: payload["title"] as? String,
			byline: payload["byline"] as? String,
			excerpt: payload["excerpt"] as? String,
			contentHTML: content,
			leadImageURL: leadImageURL,
			wordCount: (payload["wordCount"] as? NSNumber)?.intValue,
			publishedAt: ReaderPublishedDate.normalize(payload["published"] as? String),
			siteName: payload["site"] as? String,
			extractor: (payload["extractor"] as? String).flatMap(ReaderViewExtractorKind.init(rawValue:)) ?? .readability,
		)
	}

	private static func safeWebURL(_ url: URL) -> URL? {
		guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host != nil else {
			return nil
		}
		return url
	}
}

private extension String {
	var nilIfEmpty: String? {
		isEmpty ? nil : self
	}
}
