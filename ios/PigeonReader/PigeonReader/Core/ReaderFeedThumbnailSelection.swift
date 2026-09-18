import Foundation

nonisolated enum ReaderFeedThumbnailSelection {
	static func firstImageURL(in html: String, baseURL: URL?) -> URL? {
		StructuredHTMLSanitizer.imageURLs(in: html, baseURL: baseURL).first
	}
}
