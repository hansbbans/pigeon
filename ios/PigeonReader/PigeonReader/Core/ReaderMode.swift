import Foundation

enum ReaderMode: String, CaseIterable, Identifiable, Sendable {
	case feedContent = "feed-content"
	case readerView = "reader-view"
	case website

	var id: Self { self }

	var title: String {
		switch self {
		case .feedContent:
			"Feed Content"
		case .readerView:
			"Reader View"
		case .website:
			"Website"
		}
	}

	var systemImage: String {
		switch self {
		case .feedContent:
			"text.alignleft"
		case .readerView:
			"book.pages"
		case .website:
			"safari"
		}
	}

	/// Articles without an original URL can only show Feed Content.
	/// That fallback is per-article and must not be stored as the feed preference.
	static func displayMode(stored: ReaderMode, hasOriginalURL: Bool) -> ReaderMode {
		hasOriginalURL ? stored : .feedContent
	}

	static func shouldPersistSelection(hasOriginalURL: Bool) -> Bool {
		hasOriginalURL
	}
}
