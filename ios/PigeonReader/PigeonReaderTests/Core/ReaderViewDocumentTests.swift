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
	func rejectsEmptyReadabilityContentForDeterministicFallback() {
		#expect(throws: ReaderViewError.extractionFailed) {
			try ReaderViewDocument(contentHTML: "   ")
		}
	}
}
