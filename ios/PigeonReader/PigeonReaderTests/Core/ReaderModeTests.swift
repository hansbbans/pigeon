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
