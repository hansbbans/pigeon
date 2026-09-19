import Testing
@testable import PigeonReader

struct ArticleRowViewTests {
	@Test
	func hidesOnlyTheRedundantSourceExplanation() {
		#expect(ArticleRowView.shouldShowExplanation(explanation: "From Dan Go", source: "Dan Go") == false)
		#expect(ArticleRowView.shouldShowExplanation(explanation: " from dan go \n", source: "Dan Go") == false)
	}

	@Test
	func retainsMeaningfulRecommendationExplanation() {
		#expect(ArticleRowView.shouldShowExplanation(
			explanation: "You often finish and save stories from this source.",
			source: "Dan Go",
		))
	}

	@Test
	func retainsAnExplanationThatNamesADifferentSource() {
		#expect(ArticleRowView.shouldShowExplanation(explanation: "From another source", source: "Dan Go"))
	}
}
