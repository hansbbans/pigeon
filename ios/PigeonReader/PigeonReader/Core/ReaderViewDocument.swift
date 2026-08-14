import Foundation

struct ReaderViewDocument: Equatable, Sendable {
	let title: String?
	let byline: String?
	let excerpt: String?
	let contentHTML: String
	let leadImageURL: URL?

	init(
		title: String? = nil,
		byline: String? = nil,
		excerpt: String? = nil,
		contentHTML: String,
		leadImageURL: URL? = nil,
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
