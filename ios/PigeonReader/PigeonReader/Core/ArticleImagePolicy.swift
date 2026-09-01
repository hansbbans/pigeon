import Foundation

enum ArticleImagePolicy {
	/// Image Rich timeline thumbnails honor Remote Images. Ask Before Loading
	/// stays blocked until that row is tapped. Privacy Proxy never loads the
	/// publisher URL from this helper.
	enum ListThumbnail: Equatable, Sendable {
		case placeholder
		case askToLoad
		case remote(URL)
	}

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

	static func listThumbnail(
		policy: ReaderRemoteImagePolicy,
		html: String,
		baseURL: URL?,
		didRequestBlockedLoad: Bool,
	) -> ListThumbnail {
		listThumbnail(
			policy: policy,
			thumbnailURL: StructuredHTMLSanitizer.imageURLs(in: html, baseURL: baseURL).first,
			didRequestBlockedLoad: didRequestBlockedLoad,
		)
	}

	static func listThumbnail(
		policy: ReaderRemoteImagePolicy,
		thumbnailURL: URL?,
		didRequestBlockedLoad: Bool,
	) -> ListThumbnail {
		guard let thumbnailURL else {
			return .placeholder
		}

		switch policy {
		case .normal:
			return .remote(thumbnailURL)
		case .privacyProxied:
			return .placeholder
		case .blocked:
			return didRequestBlockedLoad ? .remote(thumbnailURL) : .askToLoad
		}
	}
}
