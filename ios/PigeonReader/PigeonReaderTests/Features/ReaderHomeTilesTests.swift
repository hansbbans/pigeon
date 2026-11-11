import Foundation
import Testing
@testable import PigeonReader

struct ReaderHomeTilesTests {
	@Test func unreadNeverGetsATileButKeepsItsPlaceInTheLibrary() {
		let navigation = ReaderNavigationState(items: [
			.smart(.forYou, unreadCount: 35),
			.smart(.unread, unreadCount: 2_810),
			.smart(.saved),
			.smart(.today, unreadCount: 8),
		])
		let snapshot = makeSnapshot(navigation, enabled: [.forYou, .unread, .today])

		let tiles = ReaderHomeTiles.make(snapshot: snapshot, navigation: navigation) { _ in nil }

		#expect(tiles.viewItems.map(\.smartSection) == [.forYou, .saved, .today])
		#expect(snapshot.smartItems.contains { $0.smartSection == .unread })
	}

	@Test func datelineCountsTodayEvenWhenTheTodayViewIsDisabled() {
		let navigation = ReaderNavigationState(items: [.smart(.forYou), .smart(.today, unreadCount: 8)])
		let snapshot = makeSnapshot(navigation, enabled: [.forYou])

		let tiles = ReaderHomeTiles.make(snapshot: snapshot, navigation: navigation) { _ in nil }

		#expect(tiles.viewItems.map(\.smartSection) == [.forYou])
		#expect(tiles.newTodayCount == 8)
	}

	@Test func folderTileShowsItsNewestTitledStoryWhateverTheListOrder() {
		let navigation = ReaderNavigationState(items: [
			.smart(.forYou),
			item("folder-a", kind: .folder),
			item("folder-b", kind: .folder),
		])
		let snapshot = makeSnapshot(navigation)
		let now = Date(timeIntervalSince1970: 1_800_000_000)
		// Oldest-first, as a reader-sorted cache may be, with an untitled newest story.
		let articles = [
			makeArticle(id: "old", title: "Old story", receivedAt: now.addingTimeInterval(-7_200)),
			makeArticle(id: "new", title: "  Newest story  ", receivedAt: now.addingTimeInterval(-60)),
			makeArticle(id: "blank", title: "   ", receivedAt: now),
		]

		let tiles = ReaderHomeTiles.make(snapshot: snapshot, navigation: navigation) { folder in
			folder.id == "folder-a" ? articles : nil
		}

		#expect(tiles.folders.map(\.id) == ["folder-a", "folder-b"])
		#expect(tiles.folders[0].headline == "Newest story")
		#expect(tiles.folders[1].headline == nil)
	}

	@Test func newestHeadlineIsStableWhenStoriesShareATimestamp() {
		let date = Date(timeIntervalSince1970: 1_800_000_000)
		let first = makeArticle(id: "a", title: "First", receivedAt: date)
		let second = makeArticle(id: "b", title: "Second", receivedAt: date)

		#expect(ReaderHomeTiles.newestHeadline(in: [first, second]) == "Second")
		#expect(ReaderHomeTiles.newestHeadline(in: [second, first]) == "Second")
		#expect(ReaderHomeTiles.newestHeadline(in: []) == nil)
	}

	@Test func folderTileCarriesAtMostFourFeedIconsAndThreeFeedNames() throws {
		let feeds = (1...6).map { number in
			item(
				"feed-\(number)",
				kind: .feed,
				parentID: "folder-a",
				iconURL: number == 2 ? nil : URL(string: "https://example.com/\(number).png"),
			)
		}
		let navigation = ReaderNavigationState(items: [item("folder-a", kind: .folder)] + feeds)

		let tiles = ReaderHomeTiles.make(snapshot: makeSnapshot(navigation), navigation: navigation) { _ in nil }

		let folder = try #require(tiles.folders.first)
		#expect(folder.iconURLs.map(\.lastPathComponent) == ["1.png", "3.png", "4.png", "5.png"])
		#expect(folder.feedTitles == ["feed-1", "feed-2", "feed-3"])
	}

	@Test func feedsSharingAnIconShowItOnce() throws {
		let shared = URL(string: "https://example.com/shared.png")
		let navigation = ReaderNavigationState(items: [
			item("folder-a", kind: .folder),
			item("feed-1", kind: .feed, parentID: "folder-a", iconURL: shared),
			item("feed-2", kind: .feed, parentID: "folder-a", iconURL: shared),
			item("feed-3", kind: .feed, parentID: "folder-a", iconURL: URL(string: "https://example.com/other.png")),
		])

		let tiles = ReaderHomeTiles.make(snapshot: makeSnapshot(navigation), navigation: navigation) { _ in nil }

		#expect(try #require(tiles.folders.first).iconURLs.map(\.lastPathComponent) == ["shared.png", "other.png"])
	}

	@Test func foldersGetDistinctColoursUntilThePaletteRunsOut() {
		let ids = (1...8).map { "user/-/label/Folder \($0)" }

		let indices = ReaderHomeTiles.colorIndices(for: ids)

		#expect(Set(indices).count == 8)
		#expect(indices.first == FrontPageKickerPalette.colorIndex(for: ids[0]))
		// A ninth folder cannot be unique; it falls back to its own hash.
		let nine = ReaderHomeTiles.colorIndices(for: ids + ["user/-/label/Ninth"])
		#expect(nine.last == FrontPageKickerPalette.colorIndex(for: "user/-/label/Ninth"))
		#expect(Array(nine.prefix(8)) == indices)
	}

	@Test func unreadFilterKeepsEachVisibleFoldersColour() {
		let navigation = ReaderNavigationState(items: [
			item("folder-a", kind: .folder, unread: 0),
			item("folder-b", kind: .folder, unread: 3),
		])

		let all = ReaderHomeTiles.make(snapshot: makeSnapshot(navigation), navigation: navigation) { _ in nil }
		let unread = ReaderHomeTiles.make(snapshot: makeSnapshot(navigation, filter: .unread), navigation: navigation) { _ in nil }

		#expect(all.folders[0].colorIndex != all.folders[1].colorIndex)
		#expect(unread.folders.first?.colorIndex == all.folders[1].colorIndex)
	}

	@Test func unreadFilterHidesFoldersWithNothingUnread() {
		let navigation = ReaderNavigationState(items: [
			item("folder-a", kind: .folder, unread: 0),
			item("folder-b", kind: .folder, unread: 3),
		])
		let snapshot = makeSnapshot(navigation, filter: .unread)

		let tiles = ReaderHomeTiles.make(snapshot: snapshot, navigation: navigation) { _ in nil }

		#expect(tiles.folders.map(\.id) == ["folder-b"])
	}

	@Test func viewTilesUseThreeColumnsExceptForFourViewsAndLargeText() {
		#expect(ReaderHomeTiles.viewColumnCount(itemCount: 3, usesAccessibilitySize: false) == 3)
		#expect(ReaderHomeTiles.viewColumnCount(itemCount: 4, usesAccessibilitySize: false) == 2)
		#expect(ReaderHomeTiles.viewColumnCount(itemCount: 2, usesAccessibilitySize: false) == 2)
		#expect(ReaderHomeTiles.viewColumnCount(itemCount: 0, usesAccessibilitySize: false) == 1)
		#expect(ReaderHomeTiles.viewColumnCount(itemCount: 3, usesAccessibilitySize: true) == 1)
	}

	private func makeSnapshot(
		_ navigation: ReaderNavigationState,
		enabled: Set<ReaderSection> = [.forYou, .unread, .starred, .today],
		filter: ReaderSidebarFilter = .all,
	) -> ReaderSidebarPresentationSnapshot {
		ReaderSidebarPresentationSnapshot.make(
			accountID: "account",
			selectedNavigationID: ReaderSection.forYou.rawValue,
			sidebarFilter: filter,
			enabledSmartViewSections: enabled,
			navigation: navigation,
		)
	}

	private func item(
		_ id: String,
		kind: ReaderNavigationKind,
		parentID: String? = nil,
		unread: Int = 1,
		iconURL: URL? = nil,
	) -> ReaderNavigationItem {
		ReaderNavigationItem(
			id: id, title: id, streamID: id, kind: kind, unreadCount: unread,
			parentID: parentID, feedKey: nil, iconURL: iconURL, smartSection: nil,
		)
	}

	private func makeArticle(id: String, title: String, receivedAt: Date) -> Recommendation {
		Recommendation(
			id: id, readerId: id, feedKey: "example-feed", source: "Example Feed", title: title,
			html: "<p>Story</p>", text: "Story", originalURL: nil, receivedAt: receivedAt,
			isRead: false, isStarred: false, score: 0, confidence: 0, sampleCount: 0,
			explanation: "", learningState: "",
		)
	}
}
