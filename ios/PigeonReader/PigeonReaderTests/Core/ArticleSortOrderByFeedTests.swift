import Foundation
import Testing
@testable import PigeonReader

struct ArticleSortOrderByFeedTests {
	private let folderID = "user/-/label/Tech"

	@Test func byFeedOrdersFeedsByTitleIgnoringCaseThenNewestFirstWithinEachFeed() {
		let articles = [
			story("beta-old", feed: "feed/2", source: "beta", at: 5),
			story("alpha-old", feed: "feed/1", source: "Alpha", at: 1),
			story("beta-new", feed: "feed/2", source: "beta", at: 9),
			story("gamma", feed: "feed/3", source: "Gamma", at: 3),
			story("alpha-new", feed: "feed/1", source: "Alpha", at: 4),
		]

		#expect(ArticleSortOrder.byFeed.sorted(articles).map(\.id)
			== ["alpha-new", "alpha-old", "beta-new", "beta-old", "gamma"])
	}

	@Test func titlesDifferingOnlyByCaseStayTwoUninterleavedGroups() {
		let articles = [
			story("lower-new", feed: "feed/1", source: "the verge", at: 9),
			story("upper-old", feed: "feed/0", source: "The Verge", at: 1),
			story("lower-old", feed: "feed/1", source: "the verge", at: 2),
			story("upper-new", feed: "feed/0", source: "The Verge", at: 8),
		]

		// Ordered like the sidebar (`localizedStandardCompare` puts one case
		// first); never interleaved by date, each feed newest first.
		let lowerFirst = "the verge".localizedStandardCompare("The Verge") == .orderedAscending
		#expect(ArticleSortOrder.byFeed.sorted(articles).map(\.id) == (lowerFirst
			? ["lower-new", "lower-old", "upper-new", "upper-old"]
			: ["upper-new", "upper-old", "lower-new", "lower-old"]))
	}

	@Test func sameTitleOnDifferentFeedsMakesSeparateGroups() {
		let articles = [
			story("b", feed: "feed/2", source: "Weekly", at: 9),
			story("a", feed: "feed/1", source: "Weekly", at: 1),
		]

		let sorted = ArticleSortOrder.byFeed.sorted(articles)
		let sections = ArticleFeedSection.sections(for: sorted, feeds: .empty)

		#expect(sorted.map(\.id) == ["a", "b"])
		#expect(sections.map(\.feed.id) == ["feed/1", "feed/2"])
		#expect(sections.map(\.feed.title) == ["Weekly", "Weekly"])
	}

	@Test func titlesCompareNumbersByValue() {
		let articles = [
			story("ten", feed: "feed/1", source: "Issue 10", at: 1),
			story("two", feed: "feed/2", source: "Issue 2", at: 1),
		]

		#expect(ArticleSortOrder.byFeed.sorted(articles).map(\.id) == ["two", "ten"])
	}

	@Test func withinAFeedTiesBreakLikeNewest() {
		let articles = [
			story("c", feed: "feed/1", source: "Feed", at: 5),
			story("b", feed: "feed/1", source: "Feed", at: 5),
			story("a", feed: "feed/1", source: "Feed", at: 7),
		]

		#expect(ArticleSortOrder.byFeed.sorted(articles).map(\.id) == ["a", "b", "c"])
		#expect(ArticleSortOrder.byFeed.sorted(articles) == ArticleSortOrder.newest.sorted(articles))
	}

	@Test func comparatorAgreesWithSorted() {
		let directory = sidebarDirectory()
		let articles = [
			story("s1", feed: "feed/7", source: "Stratechery", at: 1),
			story("s2", feed: "stratechery", source: "Stratechery", at: 3),
			story("x1", feed: "feed/8", source: "axios", at: 2),
			story("x2", feed: "feed/8", source: "axios", at: 2),
			story("w1", feed: "feed/9", source: "Axios", at: 4),
		]
		let sorted = ArticleSortOrder.byFeed.sorted(articles, feeds: directory)

		for left in sorted.indices {
			for right in sorted.indices where left != right {
				#expect(ArticleSortOrder.byFeed.areInIncreasingOrder(sorted[left], sorted[right], feeds: directory)
					== (left < right))
			}
		}
	}

	@Test func directoryGroupsStreamAndSyncKeysOfOneFeedUnderItsSidebarTitle() {
		let directory = sidebarDirectory()
		let articles = [
			// Stream pages key on `feed/N`, sync changes on the plain feed key.
			story("stream", feed: "feed/7", source: "Old Name", at: 1),
			story("sync", feed: "stratechery", source: "Stratechery", at: 3),
			story("other", feed: "feed/8", source: "Axios", at: 2),
		]

		let sorted = ArticleSortOrder.byFeed.sorted(articles, feeds: directory)
		let sections = ArticleFeedSection.sections(for: sorted, feeds: directory)

		#expect(sorted.map(\.id) == ["other", "sync", "stream"])
		#expect(sections.map(\.feed.id) == ["feed/8", "feed/7"])
		#expect(sections.map(\.feed.title) == ["Axios", "Stratechery"])
		#expect(sections.last?.feed.iconURL == URL(string: "https://stratechery.com/favicon.ico"))
	}

	@Test func byFeedIsOfferedOnlyInFolders() {
		#expect(ArticleSortOrder.available(forCollectionID: folderID) == [.byFeed, .newest, .oldest, .score])
		for section in ReaderSection.allCases {
			#expect(ArticleSortOrder.available(forCollectionID: section.rawValue).contains(.byFeed) == false)
			#expect(ArticleSortOrder.available(forCollectionID: section.rawValue) == ArticleSortOrder.available(for: section))
		}
		#expect(ArticleSortOrder.available(forCollectionID: "feed/1") == [.newest, .oldest, .score])
		#expect(ArticleSortOrder.available(forCollectionID: "feed/1::\(folderID)") == [.newest, .oldest, .score])
		#expect(ArticleSortOrder.available(for: nil).contains(.byFeed) == false)
	}

	@Test func foldersDefaultToByFeedAndOtherCollectionsKeepTheirDefaults() {
		#expect(ReaderNavigationItem.isFolderID(folderID))
		#expect(ReaderNavigationItem.isFolderID("feed/1::\(folderID)") == false)
		#expect(ArticleSortOrder.defaultOrder(forCollectionID: folderID) == .byFeed)
		#expect(ArticleSortOrder.defaultOrder(forCollectionID: ReaderSection.forYou.rawValue) == .recommended)
		#expect(ArticleSortOrder.defaultOrder(forCollectionID: ReaderSection.today.rawValue) == .newest)
		#expect(ArticleSortOrder.defaultOrder(forCollectionID: ReaderSection.saved.rawValue) == .newest)
		#expect(ArticleSortOrder.defaultOrder(forCollectionID: "feed/1") == .newest)
	}

	@Test func savedOrdersResolvePerCollection() {
		#expect(ArticleSortOrder.resolved(nil, forCollectionID: folderID) == .byFeed)
		#expect(ArticleSortOrder.resolved(.newest, forCollectionID: folderID) == .newest)
		#expect(ArticleSortOrder.resolved(.oldest, forCollectionID: folderID) == .oldest)
		// By Feed saved against anything but a folder falls back to its default.
		#expect(ArticleSortOrder.resolved(.byFeed, forCollectionID: ReaderSection.unread.rawValue) == .newest)
		#expect(ArticleSortOrder.resolved(.byFeed, forCollectionID: ReaderSection.forYou.rawValue) == .recommended)
		#expect(ArticleSortOrder.resolved(.byFeed, forCollectionID: "feed/1") == .newest)
		// Other saved orders keep their existing meaning.
		#expect(ArticleSortOrder.resolved(.recommended, forCollectionID: "feed/1") == .recommended)
	}

	@Test func persistedRawValuesDecodeSafely() {
		#expect(ArticleSortOrder(rawValue: "byFeed") == .byFeed)
		#expect(ArticleSortOrder(rawValue: "byAuthor") == nil)
		#expect(ArticleSortOrder.byFeed.title == "By Feed")
	}

	@Test func sectionsAreConsecutiveRunsThatKeepEveryArticleOnce() {
		let articles = [
			story("a", feed: "feed/1", source: "One", at: 3),
			story("b", feed: "feed/1", source: "One", at: 2),
			story("c", feed: "feed/2", source: "Two", at: 9),
			// A held list can briefly show a feed twice; ids stay unique.
			story("d", feed: "feed/1", source: "One", at: 1),
		]

		let sections = ArticleFeedSection.sections(for: articles, feeds: .empty)

		#expect(sections.flatMap(\.articles) == articles)
		#expect(sections.map(\.articles.count) == [2, 1, 1])
		#expect(sections.map(\.id) == ["feed/1", "feed/2", "feed/1#2"])
		#expect(ArticleFeedSection.sections(for: [], feeds: .empty).isEmpty)
	}

	@Test func cachedSnapshotPreparationDefaultsFoldersToByFeed() {
		let directory = sidebarDirectory()
		let articles = [
			story("old-strat", feed: "feed/7", source: "Stratechery", at: 1),
			story("axios", feed: "feed/8", source: "Axios", at: 2),
			story("new-strat", feed: "stratechery", source: "Stratechery", at: 3),
		]
		let otherFolder = "user/-/label/News"

		let prepared = CachedLibrarySnapshotPreparation.sortedArticlesByCollection(
			[folderID: articles, otherFolder: articles, ReaderSection.unread.rawValue: articles],
			sortOrders: [otherFolder: .newest, ReaderSection.unread.rawValue: .byFeed],
			canonicalOrder: [:],
			feeds: directory,
		)

		#expect(prepared[folderID]?.map(\.id) == ["axios", "new-strat", "old-strat"])
		#expect(prepared[otherFolder]?.map(\.id) == ["new-strat", "axios", "old-strat"])
		#expect(prepared[ReaderSection.unread.rawValue]?.map(\.id) == ["new-strat", "axios", "old-strat"])
	}

	@Test func keptStoryReturnsInsideItsFeedGroup() {
		let directory = sidebarDirectory()
		var kept = ReaderKeptArticles()
		var read = story("strat-read", feed: "stratechery", source: "Stratechery", at: 5)
		read.isRead = true
		kept.keep(read, in: folderID, filter: .unread, at: 1)
		let remaining = [
			story("axios", feed: "feed/8", source: "Axios", at: 9),
			story("strat-new", feed: "feed/7", source: "Stratechery", at: 6),
			story("strat-old", feed: "feed/7", source: "Stratechery", at: 1),
		]

		let displayed = kept.displayed(remaining, filter: .unread, order: .byFeed, feeds: directory)

		#expect(displayed.map(\.id) == ["axios", "strat-new", "strat-read", "strat-old"])
	}

	private func sidebarDirectory() -> ArticleFeedDirectory {
		ArticleFeedDirectory(navigationItems: [
			.smart(.unread),
			ReaderNavigationItem(
				id: folderID, title: "Tech", streamID: folderID, kind: .folder, unreadCount: 0,
				parentID: nil, feedKey: nil, iconURL: nil, smartSection: nil,
			),
			ReaderNavigationItem(
				id: "feed/7::\(folderID)", title: "Stratechery", streamID: "feed/7", kind: .feed, unreadCount: 0,
				parentID: folderID, feedKey: "stratechery", iconURL: URL(string: "https://stratechery.com/favicon.ico"),
				smartSection: nil,
			),
			ReaderNavigationItem(
				id: "feed/8::\(folderID)", title: "Axios", streamID: "feed/8", kind: .feed, unreadCount: 0,
				parentID: folderID, feedKey: "axios", iconURL: nil, smartSection: nil,
			),
		])
	}

	private func story(_ id: String, feed: String, source: String, at seconds: TimeInterval) -> Recommendation {
		Recommendation(
			id: id, readerId: id, feedKey: feed, source: source, title: id, html: "<p>Story</p>", text: nil,
			originalURL: nil, receivedAt: Date(timeIntervalSince1970: seconds), isRead: false, isStarred: false,
			score: 0, confidence: 0, sampleCount: 0, explanation: "", learningState: "",
		)
	}
}
