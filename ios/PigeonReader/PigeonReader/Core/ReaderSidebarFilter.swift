import Foundation

nonisolated enum ReaderSidebarFilter: String, CaseIterable, Hashable, Identifiable, Sendable {
	case all
	case unread

	var id: Self { self }

	var title: String {
		switch self {
		case .all: "All"
		case .unread: "Unread"
		}
	}
}
