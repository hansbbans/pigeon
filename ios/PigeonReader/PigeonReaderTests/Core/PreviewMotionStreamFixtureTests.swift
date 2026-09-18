import Foundation
import Testing
@testable import PigeonReader

struct PreviewMotionStreamFixtureTests {
	@Test func resolvingPaginationKeepsTheStressStoryIDsAndBoundsEachPage() throws {
		let first = try page("https://pigeon.preview/reader/api/0/stream/items/ids?s=feed/navigation-1-1&n=50")
		let refs = try #require(first["itemRefs"] as? [[String: String]])
		#expect(refs.count == 50)
		#expect(refs.first?["id"] == "feed/navigation-1-1-story-1")
		#expect(refs.last?["id"] == "feed/navigation-1-1-story-50")
		#expect(first["continuation"] as? String == "50")
		let second = try page("https://pigeon.preview/reader/api/0/stream/items/ids?s=feed/navigation-1-1&n=50&c=50")
		let remaining = try #require(second["itemRefs"] as? [[String: String]])
		#expect(remaining.count == 30)
		#expect(remaining.last?["id"] == "feed/navigation-1-1-story-80")
		#expect(second["continuation"] == nil)
	}

	@Test func bodyFixturePreservesReadStateAndDoesNotHandleUnrelatedStreams() throws {
		var request = URLRequest(url: URL(string: "https://pigeon.preview/reader/api/0/stream/items/contents")!)
		request.httpBody = Data("i=feed/navigation-1-1-story-3&i=feed/navigation-1-3-story-4".utf8)
		let response = try PreviewMotionStreamFixture.data(for: request)
		let data = try #require(response)
		let decoded = try JSONSerialization.jsonObject(with: data)
		let payload = try #require(decoded as? [String: Any])
		let items = try #require(payload["items"] as? [[String: Any]])
		#expect(items.count == 2)
		#expect(items[0]["categories"] as? [String] == ["user/-/state/com.google/read"])
		#expect(items[1]["categories"] as? [String] == [])
		let unrelated = URLRequest(url: URL(string: "https://pigeon.preview/reader/api/0/stream/items/ids?s=feed/other")!)
		#expect(try PreviewMotionStreamFixture.data(for: unrelated) == nil)
	}

	private func page(_ url: String) throws -> [String: Any] {
		let response = try PreviewMotionStreamFixture.data(for: URLRequest(url: URL(string: url)!))
		let data = try #require(response)
		let decoded = try JSONSerialization.jsonObject(with: data)
		return try #require(decoded as? [String: Any])
	}
}
