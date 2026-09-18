import Foundation
import Testing
@testable import PigeonReader

@MainActor
struct ReaderPresentedCollectionActionsTests {
	@Test func aStoryKeptOnScreenStillOpensAfterItsCachedPageWasReplaced() {
		let model = makeModel()
		let collection = ReaderNavigationItem.smart(.forYou)
		let old = story("old")
		let new = story("new")
		model.setArticles([new], for: collection)
		model.retainPresentedArticles([old], in: collection)
		model.select(article: old)
		#expect(model.selectedArticle?.id == old.id)
		#expect(Set(model.allArticles(for: collection).map(\.id)) == ["old", "new"])
	}

	@Test func retentionDoesNotOverwriteCurrentReadStateOrAnotherSelectedCollection() {
		let model = makeModel()
		let collection = ReaderNavigationItem.smart(.forYou)
		var current = story("same")
		current.isRead = true
		model.setArticles([current], for: collection)
		model.retainPresentedArticles([story("same")], in: collection)
		#expect(model.allArticles(for: collection).first?.isRead == true)
		model.select(section: .today)
		model.retainPresentedArticles([story("stale")], in: collection)
		#expect(model.allArticles(for: collection).map(\.id) == ["same"])
	}

	private func makeModel() -> ReaderAppModel {
		let model = ReaderAppModel(sessionStore: TestSessionStore(), httpClient: MockHTTPClient(),
			readwiseTokenStore: PreviewReadwiseTokenStore(), offlineStore: OfflineLibraryStore.inMemory(),
			offlineSynchronizationEnabled: false)
		model.select(section: .forYou)
		return model
	}

	private func story(_ id: String) -> Recommendation {
		Recommendation(id: id, readerId: id, feedKey: "feed", source: "Feed", title: id, html: "<p>Story</p>", text: nil,
			originalURL: nil, receivedAt: .distantPast, isRead: false, isStarred: false, score: 0,
			confidence: 0, sampleCount: 0, explanation: "", learningState: "")
	}
}
