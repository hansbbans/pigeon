import Foundation

/// Image-rich timeline thumbnails honor the same Remote Images policy as
/// in-article content. Ask Before Loading stays blocked until the reader
/// requests a specific image; Privacy Proxy never falls back to the publisher.
nonisolated enum ArticleListThumbnailRequest {
	static func loadRequest(
		for remoteURL: URL,
		policy: ReaderRemoteImagePolicy,
		session: PigeonSession?,
	) -> URLRequest? {
		switch policy {
		case .blocked:
			return nil
		case .normal, .privacyProxied:
			return PrivacyProxiedImageRequest.loadRequest(
				for: remoteURL,
				policy: policy,
				session: session,
			)
		}
	}

	static func thumbnailURL(in html: String, baseURL: URL?) -> URL? {
		StructuredHTMLSanitizer.imageURLs(in: html, baseURL: baseURL).first
	}
}
