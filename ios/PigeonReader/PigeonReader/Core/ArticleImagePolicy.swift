import Foundation

enum ArticleImagePolicy {
	static func fallbackLeadImageURL(
		bodyImageURLs: [URL],
		leadImageURL: URL?,
		failedImageURLs: Set<String>,
	) -> URL? {
		guard let leadImageURL, bodyImageURLs.contains(leadImageURL) == false else {
			return nil
		}

		let bodyHasNoUsableImage = bodyImageURLs.isEmpty || bodyImageURLs.allSatisfy { failedImageURLs.contains($0.absoluteString) }
		return bodyHasNoUsableImage ? leadImageURL : nil
	}
}
