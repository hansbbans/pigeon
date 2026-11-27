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

	@Test func timeBoxFilterNarrowsRegularCollectionsWithoutAffectingSavedOrHiddenMarkAll() async {
		let session = PigeonSession(baseURL: URL(string: "https://pigeon.example")!, token: "token")
		let model = ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: MockHTTPClient(shouldFail: true),
			offlineStore: OfflineLibraryStore.inMemory(),
			offlineSynchronizationEnabled: false,
		)
		let feed = ReaderNavigationItem(
			id: "feed/1",
			title: "Design Weekly",
			streamID: "feed/1",
			kind: .feed,
			unreadCount: 3,
			parentID: nil,
			feedKey: "feed",
			iconURL: nil,
			smartSection: nil,
		)
		let shortText = story("short", receivedAt: Date(timeIntervalSince1970: 300), wordCount: 400, mediaKind: "text")
		let mediumText = story("medium", receivedAt: Date(timeIntervalSince1970: 200), wordCount: 1900, mediaKind: "text")
		let longVideo = story("video", receivedAt: Date(timeIntervalSince1970: 100), mediaKind: "video", durationSeconds: 1080)
		model.setNavigation(ReaderNavigationState(items: [feed, .smart(.saved)]))
		model.setArticles([shortText, mediumText, longVideo], for: feed)

		let saved = ReaderNavigationItem.smart(.saved)
		let savedStory = Recommendation(
			id: "saved-1", readerId: "saved-1", feedKey: SavedItems.feedKey, source: SavedItems.title,
			title: "Saved", html: "<p>Quick</p>", text: nil, originalURL: nil, receivedAt: Date(timeIntervalSince1970: 500),
			isRead: false, isStarred: false, score: 0, confidence: 0, sampleCount: 0,
			explanation: "", learningState: "",
			length: ArticleLength(wordCount: 400, mediaKind: "text", durationSeconds: nil),
		)
		model.setArticles([savedStory], for: saved)

		// Default filter shows all three.
		#expect(model.articles(for: feed).map(\.id) == ["short", "medium", "video"])

		// Filter to Video: only the video appears in the feed, while Read It Later stays untouched.
		model.timeBoxFilter = ReaderTimeBoxFilter(kind: .video, length: .any)
		#expect(model.articles(for: feed).map(\.id) == ["video"])
		#expect(model.articles(for: saved).map(\.id) == ["saved-1"])
		#expect(model.isArticleFilterEmpty(for: feed) == false)

		// Filter to Video + Under 5 min: empty filtered state, and Mark All is disabled (no visible unread).
		model.timeBoxFilter = ReaderTimeBoxFilter(kind: .video, length: .short)
		#expect(model.articles(for: feed).isEmpty)
		#expect(model.isArticleFilterEmpty(for: feed))
		#expect(model.canMarkAllStoriesAsRead(in: feed) == false)

		// Filter to Text + Under 5 min: Mark All marks ONLY the visible short story, leaving medium & video unread.
		model.timeBoxFilter = ReaderTimeBoxFilter(kind: .text, length: .short)
		#expect(model.articles(for: feed).map(\.id) == ["short"])
		#expect(model.canMarkAllStoriesAsRead(in: feed))
		await model.markAllStoriesAsRead(in: feed)
		model.clearTimeBoxFilter()
		let byID = Dictionary(uniqueKeysWithValues: model.allArticles(for: feed).map { ($0.id, $0) })
		#expect(byID["short"]?.isRead == true)
		#expect(byID["medium"]?.isRead == false)
		#expect(byID["video"]?.isRead == false)
	}

	@Test func timeBoxFilterAppliesToSearchResultsAndFlagsSearchFilterEmpty() async throws {
		let session = PigeonSession(baseURL: URL(string: "https://pigeon.example")!, token: "token")
		let store = OfflineLibraryStore.inMemory()
		let accountID = session.storageIdentity
		let feed = ReaderNavigationItem(
			id: "feed/1",
			title: "Design Weekly",
			streamID: "feed/1",
			kind: .feed,
			unreadCount: 2,
			parentID: nil,
			feedKey: "feed",
			iconURL: nil,
			smartSection: nil,
		)
		let shortText = story("short", receivedAt: Date(timeIntervalSince1970: 300), wordCount: 400, mediaKind: "text")
		let longVideo = story("video", receivedAt: Date(timeIntervalSince1970: 200), mediaKind: "video", durationSeconds: 1080)
		try await store.saveArticles([shortText, longVideo], collectionID: feed.id, accountID: accountID)

		let model = ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: MockHTTPClient(shouldFail: true),
			offlineStore: store,
			offlineSynchronizationEnabled: false,
		)
		model.setNavigation(ReaderNavigationState(items: [feed]))
		model.setArticles([shortText, longVideo], for: feed)
		model.select(item: feed)

		await model.searchArticles(query: "Story", scope: .collection, in: feed)
		#expect(Set(model.displayedSearchResults.map(\.id)) == ["short", "video"])
		#expect(model.isSearchFilterEmpty == false)

		model.timeBoxFilter = ReaderTimeBoxFilter(kind: .video, length: .long)
		#expect(model.displayedSearchResults.map(\.id) == ["video"])
		#expect(model.isSearchFilterEmpty == false)

		model.timeBoxFilter = ReaderTimeBoxFilter(kind: .video, length: .short)
		#expect(model.displayedSearchResults.isEmpty)
		#expect(model.isSearchFilterEmpty)
	}

	private func makeModel() -> ReaderAppModel {
		let model = ReaderAppModel(sessionStore: TestSessionStore(), httpClient: MockHTTPClient(),
			offlineStore: OfflineLibraryStore.inMemory(),
			offlineSynchronizationEnabled: false)
		model.select(section: .forYou)
		return model
	}

	private func story(
		_ id: String,
		receivedAt: Date = .distantPast,
		wordCount: Int? = nil,
		mediaKind: String? = nil,
		durationSeconds: Int? = nil,
	) -> Recommendation {
		Recommendation(id: id, readerId: id, feedKey: "feed", source: "Feed", title: id, html: "<p>Story</p>", text: nil,
			originalURL: nil, receivedAt: receivedAt, isRead: false, isStarred: false, score: 0,
			confidence: 0, sampleCount: 0, explanation: "", learningState: "",
			length: ArticleLength(wordCount: wordCount, mediaKind: mediaKind, durationSeconds: durationSeconds))
	}
}
