import Foundation
import Testing
@testable import PigeonReader

struct ReaderFeedPrewarmPlannerTests {
	@Test func plannerKeepsVisibleFolderOrderAndBoundsTheSlice() {
		let folder = Self.folder()
		let first = Self.feed(id: "first", parentID: folder.id)
		let duplicate = Self.feed(id: first.id, parentID: folder.id)
		let second = Self.feed(id: "second", parentID: folder.id)
		let third = Self.feed(id: "third", parentID: folder.id)
		let unrelated = Self.feed(id: "unrelated", parentID: "other-folder")

		let result = ReaderFeedPrewarmPlanner.feeds(
			in: folder,
			visibleFeeds: [first, duplicate, unrelated, second, third],
		)

		#expect(result.map(\.id) == [first.id, second.id])
	}

	@Test func plannerRejectsNonFoldersAndNonPositiveLimits() {
		let folder = Self.folder()
		let feed = Self.feed(id: "feed", parentID: folder.id)

		#expect(ReaderFeedPrewarmPlanner.feeds(in: feed, visibleFeeds: [feed]).isEmpty)
		#expect(ReaderFeedPrewarmPlanner.feeds(in: folder, visibleFeeds: [feed], limit: 0).isEmpty)
	}

	private static func folder() -> ReaderNavigationItem {
		ReaderNavigationItem(
			id: "folder",
			title: "Folder",
			streamID: "user/-/label/Folder",
			kind: .folder,
			unreadCount: 1,
			parentID: nil,
			feedKey: nil,
			iconURL: nil,
			smartSection: nil,
		)
	}

	private static func feed(id: String, parentID: String) -> ReaderNavigationItem {
		ReaderNavigationItem(
			id: id,
			title: id,
			streamID: "feed/\(id)",
			kind: .feed,
			unreadCount: 1,
			parentID: parentID,
			feedKey: id,
			iconURL: nil,
			smartSection: nil,
		)
	}
}
