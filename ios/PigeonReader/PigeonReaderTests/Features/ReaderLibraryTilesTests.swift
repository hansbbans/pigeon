import Foundation
import Testing
@testable import PigeonReader

struct ReaderLibraryTilesTests {
	private static let design = "user/-/label/Design"
	private static let news = "user/-/label/News"

	@Test func libraryTilesListViewsFoldersWithFeedsThenUnfiledFeeds() {
		let navigation = Self.navigation()
		let now = Date(timeIntervalSince1970: 1_800_000_000)
		let tiles = ReaderLibraryTiles.make(snapshot: snapshot(navigation), navigation: navigation) { item in
			switch item.id {
			case Self.design: [article("design-new", at: now), article("design-old", at: now.addingTimeInterval(-60))]
			case "feed/1::\(Self.design)": [article("Dense headline", at: now)]
			default: nil
			}
		}

		// Every view, Unread included, unlike Home.
		#expect(tiles.viewItems.map(\.smartSection) == [.forYou, .unread, .today])
		#expect(tiles.folders.map(\.id) == [Self.design, Self.news])
		#expect(tiles.folders[0].folder.headline == "design-new")
		#expect(tiles.folders[0].feeds.map(\.id) == ["feed/1::\(Self.design)", "feed/2::\(Self.design)"])
		#expect(tiles.folders[0].feeds.map(\.headline) == ["Dense headline", nil])
		#expect(tiles.folders[1].feeds.map(\.id) == ["feed/3::\(Self.news)"])
		#expect(tiles.unfiledFeeds.map(\.id) == ["feed/9"])
		// Feeds wear their folder's colour; a feed in no folder its own.
		#expect(tiles.folders[0].feeds.allSatisfy { $0.colorIndex == tiles.folders[0].folder.colorIndex })
		#expect(tiles.unfiledFeeds[0].colorIndex == FrontPageKickerPalette.colorIndex(for: "feed/9"))
	}

	@Test func theUnreadFilterHidesReadFoldersAndFeeds() {
		let navigation = Self.navigation()

		let tiles = ReaderLibraryTiles.make(snapshot: snapshot(navigation, filter: .unread), navigation: navigation) { _ in nil }

		#expect(tiles.folders.map(\.id) == [Self.design])
		#expect(tiles.folders[0].feeds.map(\.id) == ["feed/1::\(Self.design)"])
		#expect(tiles.unfiledFeeds.isEmpty)
		// Colours never move with the filter.
		let all = ReaderLibraryTiles.make(snapshot: snapshot(navigation), navigation: navigation) { _ in nil }
		#expect(tiles.folders[0].folder.colorIndex == all.folders[0].folder.colorIndex)
	}

	private static func navigation() -> ReaderNavigationState {
		ReaderNavigationState(items: [
			.smart(.forYou), .smart(.unread, unreadCount: 3), .smart(.today),
			item(design, kind: .folder, unread: 2),
			item(news, kind: .folder, unread: 0),
			item("feed/1::\(design)", stream: "feed/1", kind: .feed, parent: design, unread: 2),
			item("feed/2::\(design)", stream: "feed/2", kind: .feed, parent: design, unread: 0),
			item("feed/3::\(news)", stream: "feed/3", kind: .feed, parent: news, unread: 0),
			item("feed/9", kind: .feed, unread: 0),
		])
	}

	private static func item(
		_ id: String, stream: String? = nil, kind: ReaderNavigationKind, parent: String? = nil, unread: Int,
	) -> ReaderNavigationItem {
		ReaderNavigationItem(
			id: id, title: id, streamID: stream ?? id, kind: kind, unreadCount: unread,
			parentID: parent, feedKey: nil, iconURL: nil, smartSection: nil,
		)
	}

	private func snapshot(_ navigation: ReaderNavigationState, filter: ReaderSidebarFilter = .all) -> ReaderSidebarPresentationSnapshot {
		ReaderSidebarPresentationSnapshot.make(
			accountID: "account", selectedNavigationID: ReaderSection.forYou.rawValue, sidebarFilter: filter,
			enabledSmartViewSections: [.forYou, .unread, .today], navigation: navigation,
		)
	}

	private func article(_ title: String, at date: Date) -> Recommendation {
		Recommendation(
			id: title, readerId: title, feedKey: "feed/1", source: "Feed", title: title, html: "", text: nil,
			originalURL: nil, receivedAt: date, isRead: false, isStarred: false,
			score: 0, confidence: 0, sampleCount: 0, explanation: "", learningState: "",
		)
	}
}
