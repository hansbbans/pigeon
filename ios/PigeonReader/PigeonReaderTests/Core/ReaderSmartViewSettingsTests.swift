import Foundation
import Testing
@testable import PigeonReader

struct ReaderSmartViewSettingsTests {
	@Test func freshDefaultsEnableEveryUserFacingSmartView() throws {
		let (defaults, suiteName) = try makeDefaults()
		defer { defaults.removePersistentDomain(forName: suiteName) }

		let store = ReaderSmartViewStore(defaults: defaults)

		#expect(store.enabledSections == ReaderSmartViewStore.defaultEnabledSections)
		#expect(store.enabledSections.contains(.unread))
		#expect(ReaderSmartViewStore.configurableSections == [.forYou, .unread, .starred, .today])
	}

	@MainActor
	@Test func existingPreferencesGainUnreadOnceDuringMigration() throws {
		let (defaults, suiteName) = try makeDefaults()
		defer { defaults.removePersistentDomain(forName: suiteName) }

		defaults.set([ReaderSection.starred.rawValue, ReaderSection.today.rawValue], forKey: ReaderSmartViewStore.key)

		let migrated = ReaderSmartViewStore(defaults: defaults)
		#expect(migrated.enabledSections == [.unread, .starred, .today])
		#expect(ReaderSmartViewStore(defaults: defaults).enabledSections == [.unread, .starred, .today])
		let model = try makeModel(defaults: defaults, smartViewStore: migrated)
		#expect(model.visibleSmartNavigationItems.compactMap(\.smartSection) == [.unread, .starred, .today])
	}

	@MainActor
	@Test func preferencesPersistAndRestoreAcrossModelLaunches() throws {
		let (defaults, suiteName) = try makeDefaults()
		defer { defaults.removePersistentDomain(forName: suiteName) }

		ReaderSmartViewStore(defaults: defaults).setEnabledSections([.today, .starred])
		let restoredModel = try makeModel(defaults: defaults)

		#expect(restoredModel.enabledSmartViewSections == [.today, .starred])
		#expect(restoredModel.visibleSmartNavigationItems.compactMap(\.smartSection) == [.starred, .today])
		#expect(restoredModel.selectedNavigationID == ReaderSection.starred.rawValue)
	}

	@MainActor
	@Test func disablingAndEnablingAViewUpdatesTheVisibleList() throws {
		let (defaults, suiteName) = try makeDefaults()
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let model = try makeModel(defaults: defaults)

		model.isForYouSmartViewEnabled = false
		#expect(model.visibleSmartNavigationItems.compactMap(\.smartSection) == [.unread, .starred, .today])
		#expect(model.smartNavigationItems.count == ReaderSection.allCases.count)

		model.isForYouSmartViewEnabled = true
		#expect(model.visibleSmartNavigationItems.compactMap(\.smartSection) == [.forYou, .unread, .starred, .today])
	}

	@MainActor
	@Test func lastEnabledViewCannotBeDisabled() throws {
		let (defaults, suiteName) = try makeDefaults()
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let store = ReaderSmartViewStore(defaults: defaults)
		store.setEnabledSections([.today])
		let model = try makeModel(defaults: defaults, smartViewStore: store)

		#expect(model.isTodaySmartViewEnabled)
		#expect(model.canDisableSmartView(.today) == false)
		model.isTodaySmartViewEnabled = false

		#expect(model.isTodaySmartViewEnabled)
		#expect(ReaderSmartViewStore(defaults: defaults).enabledSections == [.today])
	}

	@MainActor
	@Test func unreadIsConfigurableAndAppearsInVisibleNavigation() throws {
		let (defaults, suiteName) = try makeDefaults()
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let store = ReaderSmartViewStore(defaults: defaults)
		store.setEnabledSections([.forYou, .unread])
		let model = try makeModel(defaults: defaults, smartViewStore: store)
		let article = makeArticle(id: "unread-article")

		model.setArticles([article], for: .unread)
		model.select(section: .unread)

		#expect(model.smartNavigationItems.count == ReaderSection.allCases.count)
		#expect(model.smartNavigationItems.contains(where: { $0.smartSection == .unread }))
		#expect(model.visibleSmartNavigationItems.compactMap(\.smartSection) == [.forYou, .unread])
		#expect(ReaderSmartViewStore.configurableSections.contains(.unread))
		#expect(model.allArticles(for: .unread).map(\.id) == [article.id])

		model.isUnreadSmartViewEnabled = false
		#expect(model.visibleSmartNavigationItems.compactMap(\.smartSection) == [.forYou])
		#expect(ReaderSmartViewStore(defaults: defaults).enabledSections == [.forYou])
		#expect(model.isUnreadSmartViewEnabled == false)
	}

	@MainActor
	@Test func disablingSelectedViewUsesTheFirstEnabledFallbackAndKeepsCachedArticles() throws {
		let (defaults, suiteName) = try makeDefaults()
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let model = try makeModel(defaults: defaults)
		let forYouArticle = makeArticle(id: "for-you-article")
		let starredArticle = makeArticle(id: "starred-article")
		model.setArticles([forYouArticle], for: .forYou)
		model.setArticles([starredArticle], for: .starred)
		model.select(section: .forYou)
		model.select(article: forYouArticle)

		model.isForYouSmartViewEnabled = false

		#expect(model.selectedNavigationID == ReaderSection.unread.rawValue)
		#expect(model.selectedArticleID == nil)
		#expect(model.preferredCompactColumn == .content)
		#expect(model.allArticles(for: .forYou).map(\.id) == [forYouArticle.id])
		#expect(model.allArticles(for: .starred).map(\.id) == [starredArticle.id])
	}

	private func makeDefaults() throws -> (UserDefaults, String) {
		let suiteName = "pigeon-smart-views-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		return (defaults, suiteName)
	}

	@MainActor
	private func makeModel(
		defaults: UserDefaults,
		smartViewStore: ReaderSmartViewStore? = nil,
	) throws -> ReaderAppModel {
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let session = PigeonSession(baseURL: baseURL, token: "server-token")
		return ReaderAppModel(
			sessionStore: TestSessionStore(session: session),
			httpClient: MockHTTPClient(),
			readwiseTokenStore: TestReadwiseTokenStore(),
			articleFilterStore: ReaderArticleFilterStore(defaults: defaults),
			smartViewStore: smartViewStore ?? ReaderSmartViewStore(defaults: defaults),
			offlineStore: OfflineLibraryStore.inMemory(),
		)
	}

	private func makeArticle(id: String) -> Recommendation {
		Recommendation(
			id: id,
			readerId: "reader-\(id)",
			feedKey: "feed/1",
			source: "Source",
			title: "Story",
			html: "<p>Body</p>",
			text: "Body",
			originalURL: nil,
			receivedAt: .now,
			isRead: false,
			isStarred: false,
			score: 50,
			confidence: 0,
			sampleCount: 0,
			explanation: "Starting with recency",
			learningState: "Starting with recency",
		)
	}
}
