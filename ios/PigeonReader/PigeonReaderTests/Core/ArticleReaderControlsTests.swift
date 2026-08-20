import Testing
@testable import PigeonReader

struct ArticleReaderControlsTests {
	@Test func bottomBarKeepsRecEngineInTheStarSlotAndReadwiseFifth() {
		#expect(ArticleReaderControl.allCases == [
			.markRead,
			.recEngine,
			.share,
			.readingControls,
			.shareToReadwise,
		])
		#expect(ArticleReaderControl.recEngine.title == "More like this")
		#expect(ArticleReaderControl.recEngine.systemImage == "sparkles")
		#expect(ArticleReaderControl.shareToReadwise.title == "Share to Readwise")
		#expect(ArticleReaderControl.shareToReadwise.systemImage == "bookmark")
	}

	@Test func markReadTitleAndIconFollowReadState() {
		#expect(ArticleReaderControl.markRead.title(isRead: false) == "Mark read")
		#expect(ArticleReaderControl.markRead.systemImage(isRead: false) == "largecircle.fill.circle")
		#expect(ArticleReaderControl.markRead.title(isRead: true) == "Mark unread")
		#expect(ArticleReaderControl.markRead.systemImage(isRead: true) == "circle")
	}
}
