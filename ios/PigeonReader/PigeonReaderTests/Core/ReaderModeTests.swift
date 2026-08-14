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
}
