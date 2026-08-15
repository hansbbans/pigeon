import Foundation
import Testing
@testable import PigeonReader

struct ArticleReaderContentIdentityTests {
	@Test func switchingStoriesOrModesCreatesANewScrollIdentity() {
		let firstStory = ArticleReaderContentIdentity(articleID: "item-1", mode: .feedContent)

		#expect(firstStory == ArticleReaderContentIdentity(articleID: "item-1", mode: .feedContent))
		#expect(firstStory != ArticleReaderContentIdentity(articleID: "item-2", mode: .feedContent))
		#expect(firstStory != ArticleReaderContentIdentity(articleID: "item-1", mode: .readerView))
		#expect(firstStory != ArticleReaderContentIdentity(articleID: "item-2", mode: .readerView))
	}

	@Test func identityIsStableForTheSameStoryAndMode() {
		let first = ArticleReaderContentIdentity(articleID: "preview-1", mode: .readerView)
		let second = ArticleReaderContentIdentity(articleID: "preview-1", mode: .readerView)

		#expect(first == second)
		#expect(first.hashValue == second.hashValue)
	}
}
