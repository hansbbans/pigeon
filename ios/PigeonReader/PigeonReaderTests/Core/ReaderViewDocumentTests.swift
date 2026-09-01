import Foundation
import Testing
@testable import PigeonReader

struct ReaderViewDocumentTests {
	@Test
	func acceptsReadabilityPayloadAndDropsUnsafeLeadImageURL() throws {
		let document = try ReaderViewDocument(payload: [
			"title": "A readable story",
			"byline": "A. Writer",
			"excerpt": "A short excerpt",
			"content": "<article><h1>A readable story</h1><p>Body</p></article>",
			"leadImageURL": "javascript:alert(1)",
		])

		#expect(document.title == "A readable story")
		#expect(document.byline == "A. Writer")
		#expect(document.contentHTML.contains("<p>Body</p>"))
		#expect(document.leadImageURL == nil)
	}

	@Test
	func originalPage404ExplainsTheFailureWithoutUsingTheSessionBannerCopy() {
		#expect(ReaderViewError.httpStatus(404).localizedDescription.contains("not found"))
		#expect(ReaderViewError.httpStatus(404).localizedDescription.contains("Pigeon returned an error") == false)
		#expect(ReaderViewError.extractionFailed.localizedDescription.contains("readable article"))
	}

	@Test
	func rejectsEmptyReadabilityContentForDeterministicFallback() {
		#expect(throws: ReaderViewError.extractionFailed) {
			try ReaderViewDocument(contentHTML: "   ")
		}
	}

	@Test
	func readerViewDocumentBelongsOnlyToTheStoryThatRequestedIt() {
		#expect(ReaderViewDocumentOwnership.shouldApply(extractedArticleID: "story-a", visibleArticleID: "story-a"))
		#expect(ReaderViewDocumentOwnership.shouldApply(extractedArticleID: "story-a", visibleArticleID: "story-b") == false)
	}

	@Test
	func leftoverReaderViewStateDoesNotPresentThePreviousStory() {
		#expect(
			ReaderViewDocumentOwnership.presentedState(
				stored: .loaded,
				documentArticleID: "story-a",
				visibleArticleID: "story-b",
			) == .loading
		)
		#expect(
			ReaderViewDocumentOwnership.presentedState(
				stored: .failed("timed out"),
				documentArticleID: "story-a",
				visibleArticleID: "story-b",
			) == .loading
		)
		#expect(
			ReaderViewDocumentOwnership.presentedState(
				stored: .loaded,
				documentArticleID: "story-b",
				visibleArticleID: "story-b",
			) == .loaded
		)
		#expect(
			ReaderViewDocumentOwnership.presentedState(
				stored: .loading,
				documentArticleID: "story-a",
				visibleArticleID: "story-b",
			) == .loading
		)
		#expect(
			ReaderViewDocumentOwnership.presentedState(
				stored: .unavailable,
				documentArticleID: nil,
				visibleArticleID: "story-b",
			) == .unavailable
		)
	}
}
