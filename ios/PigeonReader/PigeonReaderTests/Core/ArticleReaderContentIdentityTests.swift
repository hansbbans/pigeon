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

	@Test func restoresSavedDepthOnlyWhenTheStoryChanges() {
		let firstStory = ArticleReaderContentIdentity(articleID: "item-1", mode: .feedContent)
		let nextStory = ArticleReaderContentIdentity(articleID: "item-2", mode: .feedContent)
		let sameStoryReaderView = ArticleReaderContentIdentity(articleID: "item-1", mode: .readerView)

		#expect(
			ArticleReaderContentIdentity.pendingRestoredDepth(
				previous: nil,
				current: firstStory,
				savedDepth: 0.72,
			) == 0.72
		)
		#expect(
			ArticleReaderContentIdentity.pendingRestoredDepth(
				previous: firstStory,
				current: nextStory,
				savedDepth: 0.41,
			) == 0.41
		)
		#expect(
			ArticleReaderContentIdentity.pendingRestoredDepth(
				previous: firstStory,
				current: sameStoryReaderView,
				savedDepth: 0.72,
			) == 0
		)
	}
}
