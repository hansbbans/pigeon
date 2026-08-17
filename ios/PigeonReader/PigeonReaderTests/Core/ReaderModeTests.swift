import Foundation
import Testing
@testable import PigeonReader

struct ReaderModeTests {
	@Test
	func defaultsToFeedContentAndPersistsPerFeed() throws {
		let suiteName = "pigeon-reader-mode-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let store = ReaderModeStore(defaults: defaults)

		#expect(store.mode(for: "feed/one") == .feedContent)
		store.setMode(.readerView, for: "feed/one")
		store.setMode(.website, for: "feed/two")
		#expect(store.mode(for: "feed/one") == .readerView)
		#expect(store.mode(for: "feed/two") == .website)
		#expect(store.mode(for: "feed/three") == .feedContent)
	}

	@Test
	func sameFeedDoesNotLeakReaderModeAcrossAccounts() throws {
		let suiteName = "pigeon-reader-mode-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let store = ReaderModeStore(defaults: defaults)
		let baseURL = try #require(URL(string: "https://pigeon.test"))
		let first = PigeonSession(baseURL: baseURL, token: "first")
		let second = PigeonSession(baseURL: baseURL, token: "second")

		store.setMode(.readerView, for: "daily", session: first)

		#expect(store.mode(for: "daily", session: first) == .readerView)
		#expect(store.mode(for: "daily", session: second) == .feedContent)
	}

	@Test
	func looksUpTheFirstStoredAliasAndWritesEveryAlias() throws {
		let suiteName = "pigeon-reader-mode-aliases-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let store = ReaderModeStore(defaults: defaults)

		store.setMode(.website, for: "alpha")
		#expect(store.mode(for: ["feed/7", "alpha"]) == .website)
		#expect(store.mode(for: ["alpha", "feed/7"]) == .website)
		#expect(store.mode(for: ["feed/7", "feed/8"]) == .feedContent)

		store.setMode(.readerView, for: ["feed/7", "alpha"])
		#expect(store.mode(for: "feed/7") == .readerView)
		#expect(store.mode(for: "alpha") == .readerView)
	}

	@Test
	func aliasesCanonicalFeedKeyWithStreamAndFolderIDs() throws {
		let state = ReaderNavigationCatalog.make(
			subscriptions: [
				ReaderSubscription(
					id: "feed/7",
					title: "Alpha",
					categories: [ReaderSubscriptionCategory(id: "user/-/label/Work", label: "Work")],
					url: "https://pigeon.test/feed/alpha",
				),
				ReaderSubscription(
					id: "feed/70",
					title: "Other",
					url: "https://pigeon.test/feed/other",
				),
			],
			unreadCounts: [],
			smartCounts: ReaderNavigationSmartCounts(forYou: 0, today: 0, unread: 0, starred: 0),
		)
		let subscription = FeedSubscription(
			id: "feed/7",
			title: "Alpha",
			categories: [],
			url: try #require(URL(string: "https://pigeon.test/feed/alpha")),
			htmlUrl: nil,
			iconUrl: nil,
		)

		#expect(ReaderModeIdentity.aliases(for: "alpha", navigationItems: state.items) == ["alpha", "feed/7"])
		#expect(ReaderModeIdentity.aliases(for: "feed/7", navigationItems: state.items) == ["feed/7", "alpha"])
		#expect(
			ReaderModeIdentity.aliases(for: "feed/7::user/-/label/Work", navigationItems: state.items)
				== ["feed/7::user/-/label/Work", "feed/7", "alpha"]
		)
		#expect(ReaderModeIdentity.aliases(for: "feed/70", navigationItems: state.items) == ["feed/70", "other"])
		#expect(
			ReaderModeIdentity.aliases(
				for: "alpha",
				navigationItems: [],
				subscriptions: [subscription],
			) == ["alpha", "feed/7"]
		)
	}

	@Test
	func displayModeFallsBackToFeedContentWithoutOriginalURL() {
		#expect(ReaderMode.displayMode(stored: .readerView, hasOriginalURL: false) == .feedContent)
		#expect(ReaderMode.displayMode(stored: .website, hasOriginalURL: false) == .feedContent)
		#expect(ReaderMode.displayMode(stored: .readerView, hasOriginalURL: true) == .readerView)
		#expect(ReaderMode.displayMode(stored: .website, hasOriginalURL: true) == .website)
		#expect(ReaderMode.displayMode(stored: .feedContent, hasOriginalURL: true) == .feedContent)
	}

	@Test
	func urlLessFallbackDoesNotRewriteStoredFeedMode() throws {
		let suiteName = "pigeon-reader-mode-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let store = ReaderModeStore(defaults: defaults)

		store.setMode(.readerView, for: "daily")
		#expect(store.displayMode(for: "daily", hasOriginalURL: false) == .feedContent)
		store.persistSelection(.feedContent, for: "daily", hasOriginalURL: false)
		#expect(store.mode(for: "daily") == .readerView)
		#expect(store.displayMode(for: "daily", hasOriginalURL: true) == .readerView)

		store.persistSelection(.website, for: "daily", hasOriginalURL: true)
		#expect(store.mode(for: "daily") == .website)
		store.persistSelection(.feedContent, for: "daily", hasOriginalURL: true)
		#expect(store.mode(for: "daily") == .feedContent)
		#expect(ReaderMode.shouldPersistSelection(hasOriginalURL: false) == false)
		#expect(ReaderMode.shouldPersistSelection(hasOriginalURL: true) == true)
	}
}
