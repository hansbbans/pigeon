import Foundation

/// A YouTube watchable video URL that is safe to use with the official iframe
/// player. Channel, playlist, and lookalike domains intentionally do not match.
nonisolated struct YouTubeVideo: Equatable, Hashable, Identifiable, Sendable {
	let videoID: String
	let sourceURL: URL
	let watchURL: URL
	let embedURL: URL

	var id: String { videoID }

	init?(url: URL?) {
		guard let url,
			let videoID = Self.videoID(from: url),
			let watchURL = Self.watchURL(for: videoID),
			let embedURL = Self.embedURL(for: videoID) else {
			return nil
		}

		self.videoID = videoID
		self.sourceURL = url
		self.watchURL = watchURL
		self.embedURL = embedURL
	}

	static func videoID(from url: URL?) -> String? {
		guard let url,
			let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
			let host = url.host?.lowercased(), allowedHosts.contains(host),
			url.user == nil,
			url.password == nil,
			url.port == nil else {
			return nil
		}

		let pathComponents = url.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
		let candidate: String?
		if shortHosts.contains(host) {
			guard pathComponents.count == 1 else { return nil }
			candidate = pathComponents.first
		} else if pathComponents == ["watch"] {
			let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
			let videoItems = queryItems.filter { $0.name == "v" }
			guard videoItems.count == 1 else { return nil }
			candidate = videoItems.first?.value
		} else if pathComponents.count == 2,
			["shorts", "live", "embed", "v"].contains(pathComponents[0]) {
			candidate = pathComponents[1]
		} else {
			return nil
		}

		guard let candidate, isValidVideoID(candidate) else { return nil }
		return candidate
	}

	private static let allowedHosts: Set<String> = [
		"youtube.com",
		"www.youtube.com",
		"m.youtube.com",
		"youtu.be",
		"www.youtu.be",
	]

	private static let shortHosts: Set<String> = ["youtu.be", "www.youtu.be"]

	private static func isValidVideoID(_ value: String) -> Bool {
		guard value.utf8.count == 11 else { return false }
		return value.unicodeScalars.allSatisfy { scalar in
			(scalar.value >= 48 && scalar.value <= 57)
				|| (scalar.value >= 65 && scalar.value <= 90)
				|| (scalar.value >= 97 && scalar.value <= 122)
				|| scalar.value == 45
				|| scalar.value == 95
		}
	}

	private static func watchURL(for videoID: String) -> URL? {
		var components = URLComponents()
		components.scheme = "https"
		components.host = "www.youtube.com"
		components.path = "/watch"
		components.queryItems = [URLQueryItem(name: "v", value: videoID)]
		return components.url
	}

	private static func embedURL(for videoID: String) -> URL? {
		var components = URLComponents()
		components.scheme = "https"
		components.host = "www.youtube.com"
		components.path = "/embed/\(videoID)"
		return components.url
	}
}
