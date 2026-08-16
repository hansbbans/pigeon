import Foundation

nonisolated enum PigeonDeepLink: Equatable, Sendable {
	case feed(String)
	case folder(String)
	case article(String)
	case add(URL)

	init?(url: URL) {
		guard url.scheme?.lowercased() == "pigeon", let host = url.host?.lowercased() else { return nil }
		let value = url.pathComponents.dropFirst().joined(separator: "/").removingPercentEncoding ?? ""
		switch host {
		case "feed" where value.isEmpty == false: self = .feed(value)
		case "folder" where value.isEmpty == false: self = .folder(value)
		case "article" where value.isEmpty == false: self = .article(value)
		case "add":
			guard let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "url" })?.value,
				let feedURL = URL(string: raw), let scheme = feedURL.scheme?.lowercased(),
				["http", "https"].contains(scheme), feedURL.host != nil else { return nil }
			self = .add(feedURL)
		default: return nil
		}
	}

	var url: URL {
		switch self {
		case .feed(let id): return Self.pathURL(host: "feed", value: id)
		case .folder(let id): return Self.pathURL(host: "folder", value: id)
		case .article(let id): return Self.pathURL(host: "article", value: id)
		case .add(let url):
			var components = URLComponents()
			components.scheme = "pigeon"
			components.host = "add"
			components.queryItems = [URLQueryItem(name: "url", value: url.absoluteString)]
			return components.url!
		}
	}

	private static func pathURL(host: String, value: String) -> URL {
		var components = URLComponents()
		components.scheme = "pigeon"
		components.host = host
		components.path = "/" + value
		return components.url!
	}
}
