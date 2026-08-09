import Foundation

enum ReaderDestination: Hashable, Identifiable, Sendable {
	case section(ReaderSection)
	case allFeeds
	case folder(String)
	case feed(String)

	var id: String {
		switch self {
		case .section(let section): "section:\(section.rawValue)"
		case .allFeeds: "library:all"
		case .folder(let name): "folder:\(name)"
		case .feed(let id): "feed:\(id)"
		}
	}

	var sourceSection: ReaderSection {
		switch self {
		case .section(let section): section
		case .allFeeds, .folder, .feed: .unread
		}
	}
}
