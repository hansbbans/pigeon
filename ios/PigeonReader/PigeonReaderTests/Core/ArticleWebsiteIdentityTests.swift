import Foundation
import Testing
@testable import PigeonReader

struct ArticleWebsiteIdentityTests {
	@Test func switchingStoriesOrURLsCreatesANewSafariIdentity() throws {
		let firstURL = try #require(URL(string: "https://example.com/one"))
		let secondURL = try #require(URL(string: "https://example.com/two"))
		let firstStory = ArticleWebsiteIdentity(articleID: "item-1", url: firstURL)

		#expect(firstStory == ArticleWebsiteIdentity(articleID: "item-1", url: firstURL))
		#expect(firstStory != ArticleWebsiteIdentity(articleID: "item-2", url: firstURL))
		#expect(firstStory != ArticleWebsiteIdentity(articleID: "item-1", url: secondURL))
		#expect(firstStory != ArticleWebsiteIdentity(articleID: "item-2", url: secondURL))
	}

	@Test func identityIsStableForTheSameStoryAndURL() throws {
		let url = try #require(URL(string: "https://example.com/story?page=1#comments"))
		let first = ArticleWebsiteIdentity(articleID: "preview-1", url: url)
		let second = ArticleWebsiteIdentity(articleID: "preview-1", url: url)

		#expect(first == second)
		#expect(first.hashValue == second.hashValue)
	}
}
