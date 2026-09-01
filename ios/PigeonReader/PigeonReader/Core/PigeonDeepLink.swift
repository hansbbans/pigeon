import Foundation

nonisolated enum PigeonDeepLink: Equatable, Sendable {
	case feed(String)
	case folder(String)
	case article(String, collection: String?)
	case add(URL)

	init?(url: URL) {
		guard url.scheme?.lowercased() == "pigeon", let host = url.host?.lowercased() else { return nil }
		let value = url.pathComponents.dropFirst().joined(separator: "/").removingPercentEncoding ?? ""
		let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
		switch host {
		case "feed" where value.isEmpty == false: self = .feed(value)
		case "folder" where value.isEmpty == false: self = .folder(value)
		case "article" where value.isEmpty == false:
			let collection = queryItems?
				.first(where: { $0.name == "collection" })?
				.value
				.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
			self = .article(value, collection: collection?.isEmpty == false ? collection : nil)
		case "add":
			guard let raw = queryItems?.first(where: { $0.name == "url" })?.value,
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
		case .article(let id, let collection):
			let query = collection.flatMap { value -> [URLQueryItem]? in
				let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
				return trimmed.isEmpty ? nil : [URLQueryItem(name: "collection", value: trimmed)]
			} ?? []
			return Self.pathURL(host: "article", value: id, query: query)
		case .add(let url):
			var components = URLComponents()
			components.scheme = "pigeon"
			components.host = "add"
			components.queryItems = [URLQueryItem(name: "url", value: url.absoluteString)]
			return components.url!
		}
	}

	private static func pathURL(host: String, value: String, query: [URLQueryItem] = []) -> URL {
		var components = URLComponents()
		components.scheme = "pigeon"
		components.host = host
		components.path = "/" + value
		if query.isEmpty == false {
			components.queryItems = query
		}
		return components.url!
	}
}
