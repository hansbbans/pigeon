import Foundation
import Testing
@testable import PigeonReader

@MainActor
struct TodayNavigationCountTests {
	@Test(arguments: [true, false])
	func preservesKnownUnreadTotalUntilTheLastPage(hasMore: Bool) async throws {
		let defaultsName = "pigeon-today-count-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: defaultsName))
		defer { defaults.removePersistentDomain(forName: defaultsName) }
		let session = PigeonSession(
			baseURL: try #require(URL(string: "https://pigeon.test")),
			token: UUID().uuidString,
		)
		let itemID = "tag:google.com,2005:reader/item/0000000000000001"
		var response: [String: Any] = [
			"id": "user/-/state/com.google/reading-list",
			"itemRefs": [["id": itemID]],
			"items": [[
				"id": itemID,
				"title": "Today's first story",
				"published": Int(Date.now.timeIntervalSince1970),
				"summary": ["content": "<p>A story from today.</p>"],
				"origin": ["streamId": "feed/daily", "title": "Daily"],
			]],
		]
		if hasMore { response["continuation"] = "next-page" }
		let client = MockHTTPClient(responseData: try JSONSerialization.data(withJSONObject: response))
		let store = OfflineLibraryStore.inMemory()
		let model = ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: client,
			readwiseTokenStore: TestReadwiseTokenStore(),
			readerModeStore: ReaderModeStore(defaults: defaults),
			articleFilterStore: ReaderArticleFilterStore(defaults: defaults),
			smartViewStore: ReaderSmartViewStore(defaults: defaults),
			offlineStore: store,
			offlineSynchronizationEnabled: false,
			readerTypography: ReaderTypographySettings(defaults: defaults),
			keyboardShortcuts: ReaderKeyboardShortcutSettings(defaults: defaults),
		)
		let today = ReaderNavigationItem.smart(.today, unreadCount: 100)
		model.setNavigation(ReaderNavigationState(items: [today]), markAsLoaded: true)
		model.select(section: .today)

		await model.load(collection: today, force: true)

		#expect(model.allArticles(for: today).count == 1)
		#expect(model.canLoadMore(collection: today) == hasMore)
		let expectedCount = hasMore ? 100 : 1
		#expect(model.navigation.item(withID: today.id)?.unreadCount == expectedCount)
		let snapshot = try await store.loadSnapshot(accountID: session.storageIdentity)
		#expect(snapshot.navigation?.item(withID: today.id)?.unreadCount == expectedCount)
	}
}
