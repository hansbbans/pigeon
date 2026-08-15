import Foundation

struct ReaderArticleFilterStore {
	static let keyPrefix = "pigeon.reader.article-filter."
	static let defaultFilter = ReaderArticleFilter.unread

	private let defaults: UserDefaults

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
	}

	func filter(for collectionID: String) -> ReaderArticleFilter {
		guard let rawValue = defaults.string(forKey: key(for: collectionID)),
			let filter = ReaderArticleFilter(rawValue: rawValue) else {
			return Self.defaultFilter
		}
		return filter
	}

	func setFilter(_ filter: ReaderArticleFilter, for collectionID: String) {
		defaults.set(filter.rawValue, forKey: key(for: collectionID))
	}

	func removeAll() {
		for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(Self.keyPrefix) {
			defaults.removeObject(forKey: key)
		}
	}

	private func key(for collectionID: String) -> String {
		Self.keyPrefix + collectionID
	}
}
