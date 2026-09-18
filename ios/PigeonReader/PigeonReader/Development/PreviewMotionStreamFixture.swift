#if DEBUG
import Foundation

/// Serves the same story IDs as the cached motion fixture. Resolving a feed's
/// pagination must not replace the stress-test list with the small normal demo.
nonisolated enum PreviewMotionStreamFixture {
	static let streams: Set<String> = ["feed/navigation-1-1", "feed/navigation-1-3"]
	static let storyCount = 80

	static func data(for request: URLRequest) throws -> Data? {
		guard let url = request.url else { return nil }
		if url.path == "/reader/api/0/stream/items/ids" {
			let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
			guard let stream = query.first(where: { $0.name == "s" })?.value, streams.contains(stream) else { return nil }
			let offset = min(storyCount, max(0, Int(query.first(where: { $0.name == "c" })?.value ?? "0") ?? 0))
			let limit = min(50, max(1, Int(query.first(where: { $0.name == "n" })?.value ?? "50") ?? 50))
			let end = min(storyCount, offset + limit)
			let numbers = offset < end ? Array((offset + 1)...end) : []
			var payload: [String: Any] = ["itemRefs": numbers.map { ["id": "\(stream)-story-\($0)"] }]
			if end < storyCount { payload["continuation"] = String(end) }
			return try JSONSerialization.data(withJSONObject: payload)
		}
		guard url.path == "/reader/api/0/stream/items/contents" else { return nil }
		let form = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
		let ids = URLComponents(string: "https://pigeon.preview/?\(form)")?.queryItems?.filter { $0.name == "i" }.compactMap(\.value) ?? []
		let items: [[String: Any]] = ids.compactMap { id in
			guard let boundary = id.range(of: "-story-", options: .backwards),
				let number = Int(id[boundary.upperBound...]), (1...storyCount).contains(number) else { return nil }
			let stream = String(id[..<boundary.lowerBound])
			guard streams.contains(stream) else { return nil }
			return ["id": id, "title": "Motion story \(number)", "published": 1_786_272_000 - number,
				"summary": ["content": "<p>Deterministic navigation and reading-position fixture.</p>"],
				"origin": ["streamId": stream, "title": stream],
				"categories": number.isMultiple(of: 3) ? ["user/-/state/com.google/read"] : []]
		}
		guard items.isEmpty == false else { return nil }
		return try JSONSerialization.data(withJSONObject: ["items": items])
	}
}
#endif
