import Testing
@testable import PigeonReader

struct ReaderSidebarPresentationProjectionTests {
	@Test(arguments: ReaderSidebarFilter.allCases)
	func singlePassMatchesPreviousProjectionIncludingOrderAndEmptyFolders(filter: ReaderSidebarFilter) {
		let items: [ReaderNavigationItem] = [
			.smart(.forYou), .smart(.unread, unreadCount: 4), .smart(.starred), .smart(.today),
			item("child-first", kind: .feed, parentID: "folder-a", unread: 2),
			item("folder-a", kind: .folder, unread: 2),
			item("read-child", kind: .feed, parentID: "folder-a", unread: 0),
			item("folder-b", kind: .folder, unread: 0),
			item("hidden-child", kind: .feed, parentID: "folder-b", unread: 1),
			item("empty", kind: .folder, unread: 1),
			item("unfiled", kind: .feed, unread: 3),
			item("read-unfiled", kind: .feed, unread: 0),
			item("orphan", kind: .feed, parentID: "removed", unread: 2),
		]
		let navigation = ReaderNavigationState(items: items, expandedFolderIDs: ["folder-a"])
		let enabled: Set<ReaderSection> = [.forYou, .today, .unread]
		let visible: (ReaderNavigationItem) -> Bool = { filter == .all || $0.unreadCount > 0 }
		let folders = navigation.folderItems.filter(visible)
		let expected = ReaderSidebarPresentationSnapshot(
			accountID: "account", selectedNavigationID: "folder-a", sidebarFilter: filter,
			enabledSmartViewSections: enabled,
			smartItems: navigation.smartItems.filter { item in
				guard let section = item.smartSection, section != .unread else { return false }
				return enabled.contains(section)
			}, folderItems: folders,
			feedsByFolderID: Dictionary(uniqueKeysWithValues: folders.map { ($0.id, navigation.children(of: $0.id).filter(visible)) }),
			uncategorizedFeedItems: navigation.uncategorizedFeedItems.filter(visible),
			expandedFolderIDs: navigation.expandedFolderIDs)
		let actual = ReaderSidebarPresentationSnapshot.make(accountID: "account", selectedNavigationID: "folder-a",
			sidebarFilter: filter, enabledSmartViewSections: enabled, navigation: navigation)
		#expect(actual == expected)
		#expect(actual.feedsByFolderID["removed"] == nil)
		#expect(actual.feedsByFolderID["empty"] == [])
	}

	@Test func projectionReflectsNewCountsFiltersAndMembershipWithoutAStaleCache() {
		let original = ReaderNavigationState(items: [
			item("folder", kind: .folder, unread: 0),
			item("feed", kind: .feed, parentID: "folder", unread: 0),
		])
		let updated = original.replacingCounts(["folder": 1, "feed": 1])
		let before = ReaderSidebarPresentationSnapshot.make(accountID: "a", selectedNavigationID: "folder",
			sidebarFilter: .unread, enabledSmartViewSections: [], navigation: original)
		let after = ReaderSidebarPresentationSnapshot.make(accountID: "a", selectedNavigationID: "folder",
			sidebarFilter: .unread, enabledSmartViewSections: [], navigation: updated)
		#expect(before.folderItems.isEmpty)
		#expect(after.folderItems.map(\.id) == ["folder"])
		#expect(after.feeds(in: "folder").map(\.id) == ["feed"])
	}

	private func item(_ id: String, kind: ReaderNavigationKind, parentID: String? = nil, unread: Int) -> ReaderNavigationItem {
		ReaderNavigationItem(id: id, title: id, streamID: id, kind: kind, unreadCount: unread,
			parentID: parentID, feedKey: nil, iconURL: nil, smartSection: nil)
	}
}
