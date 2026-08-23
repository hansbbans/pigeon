import SwiftUI
import Testing
@testable import PigeonReader

struct ReaderCompactArticlePresentationTests {
	@Test func compactDetailKeepsTheLibrarySplitViewOnTheFeedColumn() {
		#expect(
			ReaderCompactArticlePresentation.splitViewColumn(
				horizontalSizeClass: .compact,
				preferredColumn: .detail,
			) == .content
		)
		#expect(
			ReaderCompactArticlePresentation.isActive(
				horizontalSizeClass: .compact,
				preferredColumn: .detail,
				hasSelectedArticle: true,
			)
		)
	}

	@Test func compactFeedAndSidebarStayOnTheRequestedColumn() {
		#expect(
			ReaderCompactArticlePresentation.splitViewColumn(
				horizontalSizeClass: .compact,
				preferredColumn: .content,
			) == .content
		)
		#expect(
			ReaderCompactArticlePresentation.splitViewColumn(
				horizontalSizeClass: .compact,
				preferredColumn: .sidebar,
			) == .sidebar
		)
		#expect(
			ReaderCompactArticlePresentation.isActive(
				horizontalSizeClass: .compact,
				preferredColumn: .content,
				hasSelectedArticle: true,
			) == false
		)
	}

	@Test func compactDetailWithoutAnArticleDoesNotOwnAReaderOverlay() {
		#expect(
			ReaderCompactArticlePresentation.isActive(
				horizontalSizeClass: .compact,
				preferredColumn: .detail,
				hasSelectedArticle: false,
			) == false
		)
	}

	@Test func regularSizeClassKeepsTheOpenArticleInTheSplitView() {
		#expect(
			ReaderCompactArticlePresentation.splitViewColumn(
				horizontalSizeClass: .regular,
				preferredColumn: .detail,
			) == .detail
		)
		#expect(
			ReaderCompactArticlePresentation.isActive(
				horizontalSizeClass: .regular,
				preferredColumn: .detail,
				hasSelectedArticle: true,
			) == false
		)
	}
}
