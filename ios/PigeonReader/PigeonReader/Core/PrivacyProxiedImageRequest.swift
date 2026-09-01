import Foundation

/// Builds the same authenticated image-proxy request used by in-article
/// `pigeon-image://` loads so zooming an image cannot bypass Privacy Proxy.
nonisolated enum PrivacyProxiedImageRequest {
	static let maximumResponseBytes = 8 * 1_024 * 1_024

	static func authorizedRequest(for remoteURL: URL, session: PigeonSession) -> URLRequest? {
		guard isAllowedRemoteURL(remoteURL) else {
			return nil
		}

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

	static func loadRequest(
		for remoteURL: URL,
		policy: ReaderRemoteImagePolicy,
		session: PigeonSession?,
	) -> URLRequest? {
		switch policy {
		case .privacyProxied:
			guard let session else {
				return nil
			}
			return authorizedRequest(for: remoteURL, session: session)
		case .normal, .blocked:
			guard isAllowedRemoteURL(remoteURL) else {
				return nil
			}
			return URLRequest(url: remoteURL)
		}
	}

	static func isAllowedRemoteURL(_ url: URL) -> Bool {
		let scheme = url.scheme?.lowercased()
		return (scheme == "https" || scheme == "http") && url.host != nil
	}
}
