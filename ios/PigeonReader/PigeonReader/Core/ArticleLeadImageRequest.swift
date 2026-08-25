import Foundation

/// Decides whether a Reader View lead image that is not in the body HTML
/// should appear, and how it is fetched. Body images already honor Privacy
/// Proxy through `pigeon-image://`. The native lead fallback used
/// `URLSession.shared` and only when Remote Images was Load Normally.
nonisolated enum ArticleLeadImageRequest {
	static let maximumResponseBytes = 8 * 1_024 * 1_024

	static func shouldShowFallback(policy: ReaderRemoteImagePolicy, session: PigeonSession?) -> Bool {
		switch policy {
		case .normal:
			return true
		case .privacyProxied:
			return session != nil
		case .blocked:
			return false
		}
	}

	static func loadRequest(
		for remoteURL: URL,
		policy: ReaderRemoteImagePolicy,
		session: PigeonSession?,
	) -> URLRequest? {
		guard isAllowedRemoteURL(remoteURL) else {
			return nil
		}

		switch policy {
		case .privacyProxied:
			guard let session else {
				return nil
			}
			return privacyProxiedRequest(for: remoteURL, session: session)
		case .normal:
			return URLRequest(url: remoteURL)
		case .blocked:
			return nil
		}
	}

	static func isAllowedRemoteURL(_ url: URL) -> Bool {
		let scheme = url.scheme?.lowercased()
		return (scheme == "https" || scheme == "http") && url.host != nil
	}

	private static func privacyProxiedRequest(for remoteURL: URL, session: PigeonSession) -> URLRequest? {
		var endpoint = URLComponents(
			url: session.baseURL.appending(path: "api/v1/image-proxy"),
			resolvingAgainstBaseURL: false,
		)
		endpoint?.queryItems = [URLQueryItem(name: "url", value: remoteURL.absoluteString)]
		guard let endpointURL = endpoint?.url else {
			return nil
		}

		var request = URLRequest(url: endpointURL)
		request.timeoutInterval = 20
		request.cachePolicy = .returnCacheDataElseLoad
		request.setValue("GoogleLogin auth=pigeon/\(session.token)", forHTTPHeaderField: "Authorization")
		return request
	}
}
