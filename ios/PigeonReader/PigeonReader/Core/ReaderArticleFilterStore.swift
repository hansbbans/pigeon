import Foundation

struct ReaderArticleFilterStore {
	static let keyPrefix = "pigeon.reader.article-filter.v2."
	static let legacyKeyPrefix = "pigeon.reader.article-filter."
	static let defaultFilter = ReaderArticleFilter.unread

	private let defaults: UserDefaults

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
	}

	// Version 1 stored only the collection ID, so its values cannot be assigned safely
	// to an account. This unmerged feature intentionally leaves those entries unread;
	// removeAll() still clears them when the store is reset.
	func filter(for collectionID: String, session: PigeonSession) -> ReaderArticleFilter {
		guard let rawValue = defaults.string(forKey: key(for: collectionID, session: session)),
			let filter = ReaderArticleFilter(rawValue: rawValue) else {
			return Self.defaultFilter
		}
		return filter
	}

	func setFilter(_ filter: ReaderArticleFilter, for collectionID: String, session: PigeonSession) {
		defaults.set(filter.rawValue, forKey: key(for: collectionID, session: session))
	}

	func removeAll() {
		for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(Self.keyPrefix) || key.hasPrefix(Self.legacyKeyPrefix) {
			defaults.removeObject(forKey: key)
		}
	}

	private func key(for collectionID: String, session: PigeonSession) -> String {
		Self.keyPrefix + session.articleFilterStorageIdentity + "." + collectionID
	}
}
