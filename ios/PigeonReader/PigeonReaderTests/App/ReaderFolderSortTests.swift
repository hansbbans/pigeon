import Foundation
import Testing
@testable import PigeonReader

/// Folders open grouped by feed, and can switch back to the mixed-by-date view.
@MainActor
struct ReaderFolderSortTests {
	private static let folderID = "user/-/label/Work"
	private static let otherFolderID = "user/-/label/News"

	@Test func folderDefaultsToByFeedAndOffersTheDateOrdersToo() throws {
		let model = try makeModel()
		let folder = try #require(Self.navigation().item(withID: Self.folderID))
		let feed = try #require(Self.navigation().item(withID: "feed/7::\(Self.folderID)"))

		#expect(model.sortOrder(for: folder) == .byFeed)
		#expect(model.availableSortOrders(for: folder) == [.byFeed, .newest, .oldest, .score])
		#expect(model.sortOrder(for: feed) == .newest)
		#expect(model.availableSortOrders(for: feed).contains(.byFeed) == false)
		#expect(model.sortOrder(for: .today) == .newest)
		#expect(model.sortOrder(for: .forYou) == .recommended)

		model.setSortOrder(.byFeed, for: feed)
		model.setSortOrder(.byFeed, for: .unread)
		#expect(model.sortOrder(for: feed) == .newest)
		#expect(model.sortOrder(for: .unread) == .newest)
	}

	@Test func folderSwitchesBetweenByFeedAndMixedByDate() async throws {
		let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "folder-switch")
		let store = OfflineLibraryStore.inMemory()
		try await store.saveNavigation(Self.navigation(), accountID: session.storageIdentity)
		let model = try makeModel(session: session, offlineStore: store, httpClient: MockHTTPClient(shouldFail: true))
		await model.prepareOfflineLibrary()
		let folder = try #require(Self.navigation().item(withID: Self.folderID))
		model.setArticles(Self.folderStories, for: folder)

		#expect(model.allArticles(for: folder).map(\.id) == ["alpha-new", "alpha-old", "beta-new", "beta-old"])

		model.setSortOrder(.newest, for: folder)
		#expect(model.allArticles(for: folder).map(\.id) == ["beta-new", "alpha-new", "beta-old", "alpha-old"])

		model.setSortOrder(.byFeed, for: folder)
		#expect(model.sortOrder(for: folder) == .byFeed)
		#expect(model.allArticles(for: folder).map(\.id) == ["alpha-new", "alpha-old", "beta-new", "beta-old"])
	}

	@Test func renamingAFeedMovesItsGroupInAnOpenFolder() async throws {
		let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "folder-rename")
		let store = OfflineLibraryStore.inMemory()
		try await store.saveNavigation(Self.navigation(), accountID: session.storageIdentity)
		let model = try makeModel(session: session, offlineStore: store, httpClient: MockHTTPClient(shouldFail: true))
		await model.prepareOfflineLibrary()
		let folder = try #require(Self.navigation().item(withID: Self.folderID))
		model.setArticles(Self.folderStories, for: folder)
		#expect(model.allArticles(for: folder).map(\.id) == ["alpha-new", "alpha-old", "beta-new", "beta-old"])

		// "alpha" becomes "Zulu": its group moves after Beta, not just its label.
		model.setNavigation(Self.navigation(alphaTitle: "Zulu"))

		#expect(model.allArticles(for: folder).map(\.id) == ["beta-new", "beta-old", "alpha-new", "alpha-old"])
	}

	@Test func restoredFoldersUseTheirSavedChoiceOrByFeed() async throws {
		let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "folder-sort")
		let store = OfflineLibraryStore.inMemory()
		try await store.saveNavigation(Self.navigation(), accountID: session.storageIdentity)
		try await store.saveArticles(Self.folderStories, collectionID: Self.folderID, accountID: session.storageIdentity)
		try await store.saveArticles(Self.folderStories, collectionID: Self.otherFolderID, accountID: session.storageIdentity)
		var restoration = ReaderRestorationState.initial
		restoration.sortOrders = [
			// Written by a newer build: unknown, so the folder keeps its default.
			Self.folderID: "byAuthor",
			Self.otherFolderID: ArticleSortOrder.newest.rawValue,
			// By Feed is folder-only; anywhere else it falls back.
			ReaderSection.unread.rawValue: ArticleSortOrder.byFeed.rawValue,
		]
		try await store.saveRestoration(restoration, accountID: session.storageIdentity)
		let model = try makeModel(session: session, offlineStore: store, httpClient: MockHTTPClient(shouldFail: true))

		await model.prepareOfflineLibrary()

		let folder = try #require(model.navigation.item(withID: Self.folderID))
		let otherFolder = try #require(model.navigation.item(withID: Self.otherFolderID))
		#expect(model.sortOrder(for: folder) == .byFeed)
		#expect(model.allArticles(for: folder).map(\.id) == ["alpha-new", "alpha-old", "beta-new", "beta-old"])
		#expect(model.sortOrder(for: otherFolder) == .newest)
		#expect(model.allArticles(for: otherFolder).map(\.id) == ["beta-new", "alpha-new", "beta-old", "alpha-old"])
		#expect(model.sortOrder(for: .unread) == .newest)
	}

	/// Alpha's stories arrive under both key spellings (stream `feed/7`, sync
	/// `alpha`), and its sidebar title is lowercase.
	private static let folderStories = [
		story("alpha-old", feed: "feed/7", at: 1),
		story("beta-old", feed: "feed/8", at: 2),
		story("alpha-new", feed: "alpha", at: 3),
		story("beta-new", feed: "beta", at: 4),
	]

	private static func navigation(alphaTitle: String = "alpha") -> ReaderNavigationState {
		ReaderNavigationCatalog.make(
			subscriptions: [
				ReaderSubscription(
					id: "feed/8", title: "Beta",
					categories: [ReaderSubscriptionCategory(id: folderID, label: "Work")],
					url: "https://pigeon.test/feed/beta",
				),
				ReaderSubscription(
					id: "feed/7", title: alphaTitle,
					categories: [
						ReaderSubscriptionCategory(id: folderID, label: "Work"),
						ReaderSubscriptionCategory(id: otherFolderID, label: "News"),
					],
					url: "https://pigeon.test/feed/alpha",
				),
			],
			unreadCounts: [],
			smartCounts: ReaderNavigationSmartCounts(forYou: 0, today: 0, unread: 0, starred: 0),
		)
	}

	private static func story(_ id: String, feed: String, at seconds: TimeInterval) -> Recommendation {
		Recommendation(
			id: id, readerId: id, feedKey: feed, source: "Source", title: id, html: "<p>Story</p>", text: nil,
			originalURL: nil, receivedAt: Date(timeIntervalSince1970: seconds), isRead: false, isStarred: false,
			score: 0, confidence: 0, sampleCount: 0, explanation: "", learningState: "",
		)
	}

	private func makeModel(
		session: PigeonSession? = nil,
		offlineStore: OfflineLibraryStore = .inMemory(),
		httpClient: MockHTTPClient = MockHTTPClient(),
	) throws -> ReaderAppModel {
		let resolvedSession = try session ?? PigeonSession(baseURL: #require(URL(string: "https://pigeon.test")), token: "token")
		let defaults = try #require(UserDefaults(suiteName: "pigeon-folder-sort-\(UUID().uuidString)"))
		return ReaderAppModel(
			sessionStore: TestSessionStore(session: resolvedSession),
			httpClient: httpClient,
			articleFilterStore: ReaderArticleFilterStore(defaults: defaults),
			offlineStore: offlineStore,
			// Hydration from `offlineStore` needs it; the HTTP client fails, so nothing syncs.
			offlineSynchronizationEnabled: true,
			offlineSyncDelay: { _ in },
		)
	}
}
