import Foundation
import Testing
@testable import PigeonReader

struct ReaderArticleIdentityTests {
	@Test(arguments: [
		("123", "123"),
		("abc-def_9", "abc-def_9"),
		("ABC", "abc"),
		("  abc\n", "abc"),
		("", ""),
		("   ", ""),
		("tag:google.com,2005:reader/item/000000000000007b", "123"),
		("tag:google.com,2005:reader/item/not-hex", "tag:google.com,2005:reader/item/not-hex"),
		("TAG:google.com,2005:reader/item/7b", "tag:google.com,2005:reader/item/7b"),
		("Éclair", "éclair"),
	])
	func normalizedCanonicalizesIDs(raw: String, expected: String) {
		#expect(ReaderArticleIdentity.normalized(raw) == expected)
	}

	@Test
	func articlesMatchThroughAnySharedAlias() {
		let googleID = "tag:google.com,2005:reader/item/000000000000007b"
		#expect(ReaderArticleIdentity.matches(Self.article(id: "row-1", readerID: googleID), Self.article(id: "123", readerID: "other")))
		#expect(ReaderArticleIdentity.matches(Self.article(id: "ROW-1", readerID: "a"), Self.article(id: "b", readerID: " row-1 ")))
		#expect(ReaderArticleIdentity.matches(Self.article(id: "x", readerID: "y"), Self.article(id: "z", readerID: "w")) == false)
	}

	@Test
	func emptyIDsNeverMatch() {
		#expect(ReaderArticleIdentity.matches(Self.article(id: "", readerID: " "), Self.article(id: "", readerID: "")) == false)
		#expect(ReaderArticleIdentity.matches(Self.article(id: "a", readerID: ""), id: "") == false)
		#expect(ReaderArticleIdentity.matches(Self.article(id: "a", readerID: ""), id: " A "))
		#expect(ReaderArticleIdentity.matches(Self.article(id: "", readerID: "123"), id: "tag:google.com,2005:reader/item/7b"))
	}

	private static func article(id: String, readerID: String) -> Recommendation {
		Recommendation(
			id: id,
			readerId: readerID,
			feedKey: "feed",
			source: "Source",
			title: "Title",
			html: "",
			text: "Text",
			originalURL: nil,
			receivedAt: Date(timeIntervalSince1970: 0),
			isRead: false,
			isStarred: false,
			score: 0,
			confidence: 0,
			sampleCount: 0,
			explanation: "",
			learningState: "",
		)
	}
}
