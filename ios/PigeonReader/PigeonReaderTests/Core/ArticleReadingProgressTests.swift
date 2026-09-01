import Foundation
import Testing
@testable import PigeonReader

struct ArticleReadingProgressTests {
	@Test func bodyLayoutIdentityChangesWhenTheArticleOrContentChanges() {
		let first = ArticleBodyLayoutIdentity(articleID: "story-a", content: "<p>First</p>")
		#expect(first == ArticleBodyLayoutIdentity(articleID: "story-a", content: "<p>First</p>"))
		#expect(first != ArticleBodyLayoutIdentity(articleID: "story-b", content: "<p>First</p>"))
		#expect(first != ArticleBodyLayoutIdentity(articleID: "story-a", content: "<p>Second</p>"))
	}

	@Test func unmeasuredBodyNeverCountsAsReadEvenWhenTheHeaderFits() {
		#expect(
			ArticleReadingProgress.depth(
				offset: 0,
				maximumOffset: 0,
				contentHeight: 280,
				isBodyLaidOut: false,
			) == 0
		)
	}

	@Test func aLaidOutStoryThatFitsOnScreenIsFullyRead() {
		#expect(
			ArticleReadingProgress.depth(
				offset: 0,
				maximumOffset: 0,
				contentHeight: 420,
				isBodyLaidOut: true,
			) == 1
		)
		#expect(
			ArticleReadingProgress.depth(
				offset: 0,
				maximumOffset: 1,
				contentHeight: 420,
				isBodyLaidOut: true,
			) == 1
		)
	}

	@Test func emptyOrPlaceholderContentDoesNotCountAsRead() {
		#expect(
			ArticleReadingProgress.depth(
				offset: 0,
				maximumOffset: 0,
				contentHeight: 0,
				isBodyLaidOut: true,
			) == 0
		)
		#expect(
			ArticleReadingProgress.depth(
				offset: 0,
				maximumOffset: 0,
				contentHeight: 1,
				isBodyLaidOut: true,
			) == 0
		)
	}

	@Test func scrollableStoriesUseOffsetOverMaximumOffset() {
		#expect(
			ArticleReadingProgress.depth(
				offset: 600,
				maximumOffset: 1_000,
				contentHeight: 1_800,
				isBodyLaidOut: true,
			) == 0.6
		)
		#expect(
			ArticleReadingProgress.depth(
				offset: 590,
				maximumOffset: 1_000,
				contentHeight: 1_800,
				isBodyLaidOut: true,
			) == 0.59
		)
		#expect(
			ArticleReadingProgress.depth(
				offset: -20,
				maximumOffset: 1_000,
				contentHeight: 1_800,
				isBodyLaidOut: true,
			) == 0
		)
		#expect(
			ArticleReadingProgress.depth(
				offset: 1_200,
				maximumOffset: 1_000,
				contentHeight: 1_800,
				isBodyLaidOut: true,
			) == 1
		)
	}

	@Test func pendingRestorationReleasesForLaidOutShortStoriesButNotPlaceholders() {
		#expect(
			ArticleReadingProgress.shouldConsumePendingRestoredDepth(
				pendingDepth: 0,
				maximumOffset: 0,
				isBodyLaidOut: true,
			)
		)
		#expect(
			ArticleReadingProgress.shouldConsumePendingRestoredDepth(
				pendingDepth: 0,
				maximumOffset: 0,
				isBodyLaidOut: false,
			) == false
		)
		#expect(
			ArticleReadingProgress.shouldConsumePendingRestoredDepth(
				pendingDepth: 0.6,
				maximumOffset: 500,
				isBodyLaidOut: false,
			)
		)
		#expect(
			ArticleReadingProgress.shouldConsumePendingRestoredDepth(
				pendingDepth: nil,
				maximumOffset: 0,
				isBodyLaidOut: true,
			) == false
		)
	}
}
