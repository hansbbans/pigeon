import Foundation

struct ReaderNavigationState: Equatable, Sendable {
	var items: [ReaderNavigationItem]
	var expandedFolderIDs: Set<String>

	init(items: [ReaderNavigationItem] = [], expandedFolderIDs: Set<String> = []) {
		self.items = items
		self.expandedFolderIDs = expandedFolderIDs
	}

	static var initial: Self {
		Self(items: ReaderSection.allCases.map { ReaderNavigationItem.smart($0) })
	}

	var smartItems: [ReaderNavigationItem] {
		items.filter { $0.kind == .smart }
	}

	var folderItems: [ReaderNavigationItem] {
		items.filter { $0.kind == .folder }
	}

	var uncategorizedFeedItems: [ReaderNavigationItem] {
		items.filter { $0.kind == .feed && $0.parentID == nil }
	}

	func children(of folderID: String) -> [ReaderNavigationItem] {
		items.filter { $0.kind == .feed && $0.parentID == folderID }
	}

	func item(withID id: String) -> ReaderNavigationItem? {
		items.first { $0.id == id }
	}

	func replacingCount(for itemID: String, with count: Int) -> Self {
		var copy = self
		let normalizedCount = max(count, 0)
		copy.items = items.map { item in
			guard item.id == itemID || (item.kind == .feed || item.kind == .folder) && item.streamID == itemID else {
				return item
			}
			return ReaderNavigationItem(
				id: item.id,
				title: item.title,
				streamID: item.streamID,
				kind: item.kind,
				unreadCount: normalizedCount,
				parentID: item.parentID,
				feedKey: item.feedKey,
				iconURL: item.iconURL,
				smartSection: item.smartSection,
			)
		}
		return copy
	}

	func replacingCounts(_ counts: [String: Int]) -> Self {
		var copy = self
		copy.items = items.map { item in
			let count = counts[item.id] ?? counts[item.streamID]
			guard let count else {
				return item
			}
			return ReaderNavigationItem(
				id: item.id,
				title: item.title,
				streamID: item.streamID,
				kind: item.kind,
				unreadCount: max(count, 0),
				parentID: item.parentID,
				feedKey: item.feedKey,
				iconURL: item.iconURL,
				smartSection: item.smartSection,
			)
		}
		return copy
	}

	mutating func toggleFolder(_ folderID: String) {
		if expandedFolderIDs.contains(folderID) {
			expandedFolderIDs.remove(folderID)
		} else if folderItems.contains(where: { $0.id == folderID }) {
			expandedFolderIDs.insert(folderID)
		}
	}

	mutating func expandFolder(_ folderID: String) {
		if folderItems.contains(where: { $0.id == folderID }) {
			expandedFolderIDs.insert(folderID)
		}
	}

	mutating func preserveExpansion(from previous: Self) {
		expandedFolderIDs = previous.expandedFolderIDs.intersection(Set(folderItems.map(\.id)))
	}
}
