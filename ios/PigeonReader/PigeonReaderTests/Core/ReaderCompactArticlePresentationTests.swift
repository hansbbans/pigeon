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

	@Test func frontPageNavigatesARegularWindowPageByPage() {
		#expect(ReaderCompactArticlePresentation.navigationSizeClass(window: .regular, homeLayout: .frontPage) == .compact)
	}

	@Test func classicKeepsTheRegularSplitViewAndCompactStaysCompact() {
		#expect(ReaderCompactArticlePresentation.navigationSizeClass(window: .regular, homeLayout: .classic) == .regular)
		#expect(ReaderCompactArticlePresentation.navigationSizeClass(window: .compact, homeLayout: .classic) == .compact)
		#expect(ReaderCompactArticlePresentation.navigationSizeClass(window: .compact, homeLayout: .frontPage) == .compact)
		#expect(ReaderCompactArticlePresentation.navigationSizeClass(window: nil, homeLayout: .frontPage) == nil)
	}

	@Test func switchingAnIPadToFrontPageWithAStoryOpenShowsThePage() {
		typealias Presentation = ReaderCompactArticlePresentation
		// Classic on iPad shows the story beside the list. Front Page collapses
		// the window, so keeping `.detail` would cover it with that story.
		#expect(Presentation.columnAfterLayoutChange(window: .regular, homeLayout: .frontPage, preferredColumn: .detail) == .content)
		#expect(Presentation.isActive(
			horizontalSizeClass: Presentation.navigationSizeClass(window: .regular, homeLayout: .frontPage),
			preferredColumn: Presentation.columnAfterLayoutChange(window: .regular, homeLayout: .frontPage, preferredColumn: .detail),
			hasSelectedArticle: true,
		) == false)
		// Home and the list stay where they are.
		#expect(Presentation.columnAfterLayoutChange(window: .regular, homeLayout: .frontPage, preferredColumn: .sidebar) == .sidebar)
		#expect(Presentation.columnAfterLayoutChange(window: .regular, homeLayout: .frontPage, preferredColumn: .content) == .content)
		// Back to Classic keeps the story beside the list.
		#expect(Presentation.columnAfterLayoutChange(window: .regular, homeLayout: .classic, preferredColumn: .detail) == .detail)
		// A phone already reads full screen in both layouts.
		#expect(Presentation.columnAfterLayoutChange(window: .compact, homeLayout: .frontPage, preferredColumn: .detail) == .detail)
	}
}
