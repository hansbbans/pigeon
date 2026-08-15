import Foundation
import Testing
@testable import PigeonReader

struct ReaderArticleFilterStoreTests {
	@Test
	func defaultsToUnreadAndPersistsPerCollection() throws {
		let suiteName = "pigeon-article-filter-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let session = try makeSession(token: "server-token")
		let store = ReaderArticleFilterStore(defaults: defaults)

		#expect(store.filter(for: "feed/one", session: session) == .unread)
		#expect(store.filter(for: "forYou", session: session) == .unread)
		store.setFilter(.unread, for: "feed/one", session: session)
		store.setFilter(.all, for: "feed/two", session: session)
		store.setFilter(.read, for: "user/-/label/Work", session: session)
		#expect(store.filter(for: "feed/one", session: session) == .unread)
		let feedOneKey = ReaderArticleFilterStore.keyPrefix + session.articleFilterStorageIdentity + ".feed/one"
		#expect(defaults.string(forKey: feedOneKey) == "unread")
		#expect(store.filter(for: "feed/two", session: session) == .all)
		#expect(store.filter(for: "user/-/label/Work", session: session) == .read)
		#expect(store.filter(for: "feed/three", session: session) == .unread)
		let missingFeedKey = ReaderArticleFilterStore.keyPrefix + session.articleFilterStorageIdentity + ".feed/three"
		#expect(defaults.string(forKey: missingFeedKey) == nil)
	}

	@Test
	func sameCollectionIDIsolatedBetweenSessionIdentities() throws {
		let suiteName = "pigeon-article-filter-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let firstSession = try makeSession(token: "first-token")
		let secondSession = try makeSession(token: "second-token")
		let store = ReaderArticleFilterStore(defaults: defaults)

		store.setFilter(.all, for: "forYou", session: firstSession)
		store.setFilter(.read, for: "forYou", session: secondSession)

		#expect(store.filter(for: "forYou", session: firstSession) == .all)
		#expect(store.filter(for: "forYou", session: secondSession) == .read)
		let storedKeys = defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix(ReaderArticleFilterStore.keyPrefix) }
		#expect(storedKeys.count == 2)
		#expect(storedKeys.allSatisfy { $0.contains("first-token") == false && $0.contains("second-token") == false })
	}

	@Test
	func normalizesServerURLBeforeCreatingStorageIdentity() throws {
		let firstSession = try makeSession(baseURL: "https://pigeon.test/reader/?ignored=true", token: "same-token")
		let secondSession = try makeSession(baseURL: "https://pigeon.test/reader", token: "same-token")

		#expect(firstSession.articleFilterStorageIdentity == secondSession.articleFilterStorageIdentity)
	}

	@Test
	func doesNotReadLegacyCollectionOnlyValues() throws {
		let suiteName = "pigeon-article-filter-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let session = try makeSession(token: "server-token")
		let store = ReaderArticleFilterStore(defaults: defaults)
		defaults.set(ReaderArticleFilter.all.rawValue, forKey: ReaderArticleFilterStore.legacyKeyPrefix + "forYou")

		#expect(store.filter(for: "forYou", session: session) == .unread)
	}

	private func makeSession(baseURL: String = "https://pigeon.test", token: String) throws -> PigeonSession {
		PigeonSession(baseURL: try #require(URL(string: baseURL)), token: token)
	}
}
