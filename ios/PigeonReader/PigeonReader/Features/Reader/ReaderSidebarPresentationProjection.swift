import Foundation

extension ReaderSidebarPresentationSnapshot {
	/// Project the library in one pass. Repeatedly filtering every navigation
	/// item for each folder made every sidebar redraw scale with folders × feeds.
	nonisolated static func make(
		accountID: String?,
		selectedNavigationID: String,
		sidebarFilter: ReaderSidebarFilter,
		enabledSmartViewSections: Set<ReaderSection>,
		navigation: ReaderNavigationState
	) -> Self {
		var smartItems: [ReaderNavigationItem] = []
		var folderItems: [ReaderNavigationItem] = []
		var feedsByFolderID: [String: [ReaderNavigationItem]] = [:]
		var uncategorizedFeedItems: [ReaderNavigationItem] = []
		for item in navigation.items {
			switch item.kind {
			case .smart:
				if let section = item.smartSection, section != .unread,
					enabledSmartViewSections.contains(section) {
					smartItems.append(item)
				}
			case .folder:
				if sidebarFilter == .all || item.unreadCount > 0 {
					folderItems.append(item)
				}
			case .feed:
				guard sidebarFilter == .all || item.unreadCount > 0 else { continue }
				if let folderID = item.parentID {
					feedsByFolderID[folderID, default: []].append(item)
				} else {
					uncategorizedFeedItems.append(item)
				}
			}
		}
		// Include empty visible folders, and omit children of hidden/deleted folders.
		let visibleFeeds = Dictionary(folderItems.map { ($0.id, feedsByFolderID[$0.id, default: []]) },
			uniquingKeysWith: { first, _ in first })
		return Self(accountID: accountID, selectedNavigationID: selectedNavigationID,
			sidebarFilter: sidebarFilter, enabledSmartViewSections: enabledSmartViewSections,
			smartItems: smartItems, folderItems: folderItems, feedsByFolderID: visibleFeeds,
			uncategorizedFeedItems: uncategorizedFeedItems, expandedFolderIDs: navigation.expandedFolderIDs)
	}
}
