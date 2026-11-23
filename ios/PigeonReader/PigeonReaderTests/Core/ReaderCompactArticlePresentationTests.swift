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

	@Test func cardsNavigatesCompactInARegularWindow() {
		#expect(ReaderCompactArticlePresentation.navigationSizeClass(window: .regular, look: .cards) == .compact)
	}

	@Test func reederKeepsTheRegularSplitViewAndCompactStaysCompact() {
		#expect(ReaderCompactArticlePresentation.navigationSizeClass(window: .regular, look: .reeder) == .regular)
		#expect(ReaderCompactArticlePresentation.navigationSizeClass(window: .compact, look: .reeder) == .compact)
		#expect(ReaderCompactArticlePresentation.navigationSizeClass(window: .compact, look: .cards) == .compact)
		#expect(ReaderCompactArticlePresentation.navigationSizeClass(window: nil, look: .cards) == nil)
	}

	@Test func switchingAnIPadToCardsWithAStoryOpenShowsThePage() {
		typealias Presentation = ReaderCompactArticlePresentation
		// Reeder on iPad shows the story beside the list. Cards collapses the
		// window, so keeping `.detail` would cover it with that story.
		#expect(Presentation.columnAfterLookChange(window: .regular, look: .cards, preferredColumn: .detail) == .content)
		#expect(Presentation.isActive(
			horizontalSizeClass: Presentation.navigationSizeClass(window: .regular, look: .cards),
			preferredColumn: Presentation.columnAfterLookChange(window: .regular, look: .cards, preferredColumn: .detail),
			hasSelectedArticle: true,
		) == false)
		// Home and the list stay where they are.
		#expect(Presentation.columnAfterLookChange(window: .regular, look: .cards, preferredColumn: .sidebar) == .sidebar)
		#expect(Presentation.columnAfterLookChange(window: .regular, look: .cards, preferredColumn: .content) == .content)
		// Back to Reeder keeps the story beside the list.
		#expect(Presentation.columnAfterLookChange(window: .regular, look: .reeder, preferredColumn: .detail) == .detail)
		// A phone already reads full screen in both looks.
		#expect(Presentation.columnAfterLookChange(window: .compact, look: .cards, preferredColumn: .detail) == .detail)
	}
}
