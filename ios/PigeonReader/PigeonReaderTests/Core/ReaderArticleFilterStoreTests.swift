import Foundation
import Testing
@testable import PigeonReader

struct ReaderArticleFilterStoreTests {
	@Test
	func defaultsToUnreadAndPersistsPerCollection() throws {
		let suiteName = "pigeon-article-filter-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let store = ReaderArticleFilterStore(defaults: defaults)

		#expect(store.filter(for: "feed/one") == .unread)
		#expect(store.filter(for: "forYou") == .unread)
		store.setFilter(.unread, for: "feed/one")
		store.setFilter(.all, for: "feed/two")
		store.setFilter(.read, for: "user/-/label/Work")
		#expect(store.filter(for: "feed/one") == .unread)
		#expect(defaults.string(forKey: ReaderArticleFilterStore.keyPrefix + "feed/one") == "unread")
		#expect(store.filter(for: "feed/two") == .all)
		#expect(store.filter(for: "user/-/label/Work") == .read)
		#expect(store.filter(for: "feed/three") == .unread)
		#expect(defaults.string(forKey: ReaderArticleFilterStore.keyPrefix + "feed/three") == nil)
	}
}
