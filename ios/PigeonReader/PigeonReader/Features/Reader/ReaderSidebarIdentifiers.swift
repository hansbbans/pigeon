import Foundation

nonisolated enum ReaderSidebarCoordinateSpace {
	static let name = "reader-sidebar-coordinate-space"
}

nonisolated enum ReaderSidebarAccessibility {
	static let sidebar = "reader-sidebar"

	static func item(_ id: String) -> String {
		"reader-sidebar-item-\(id)"
	}

	static func folderToggle(_ id: String) -> String {
		"reader-sidebar-folder-toggle-\(id)"
	}
}
