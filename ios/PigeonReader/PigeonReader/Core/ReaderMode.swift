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
}
