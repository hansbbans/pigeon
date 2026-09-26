#if DEBUG
import Foundation

enum PreviewNavigationFixture {
	static func install(in model: ReaderAppModel) {
		let stress = ProcessInfo.processInfo.arguments.contains("-reader-motion-stress-fixture")
		let refreshFixture = ProcessInfo.processInfo.arguments.contains("-reader-folder-refresh-fixture")
		var items = model.navigation.smartItems
		for folderNumber in 1...(stress ? 100 : 6) {
			let title = String(format: "Folder %02d", folderNumber)
			let folderID = "navigation-folder-\(folderNumber)"
			let folder = ReaderNavigationItem(
				id: folderID, title: title, streamID: "user/-/label/\(title)",
				kind: .folder, unreadCount: 6, parentID: nil,
				feedKey: nil, iconURL: nil, smartSection: nil
			)
			items.append(folder)
			for feedNumber in 1...(stress ? 30 : 6) {
				let id = "feed/navigation-\(folderNumber)-\(feedNumber)"
				let feed = ReaderNavigationItem(
					id: id, title: String(format: "Feed %02d.%02d", folderNumber, feedNumber), streamID: id,
					kind: .feed, unreadCount: 1, parentID: folderID,
					feedKey: "navigation-\(folderNumber)-\(feedNumber)", iconURL: nil, smartSection: nil
				)
				items.append(feed)
				if folderNumber == 1, feedNumber == 1 || feedNumber == 3 {
					let stories = stress ? stressStories(for: feed) : [PreviewData.articles[feedNumber == 1 ? 0 : 1]]
					model.setArticles(stories, for: feed)
					model.setArticleFilter(.all, for: feed)
				}
			}
			if folderNumber == 1, refreshFixture {
				model.setArticles([PreviewData.articles[0]], for: folder)
				model.setArticleFilter(.all, for: folder)
			}
		}
		model.setNavigation(ReaderNavigationState(items: items), markAsLoaded: true)
	}

	private static func stressStories(for feed: ReaderNavigationItem) -> [Recommendation] {
		(1...80).map { number in
			Recommendation(id: "\(feed.id)-story-\(number)", readerId: "\(feed.id)-story-\(number)",
				feedKey: feed.feedKey ?? feed.id, source: feed.title, title: "Motion story \(number)",
				html: "<p>Deterministic navigation and reading-position fixture.</p>", text: "Fixture story",
				originalURL: nil, receivedAt: Date(timeIntervalSince1970: 1_786_272_000 - Double(number)),
				isRead: number.isMultiple(of: 3), isStarred: false, score: 0, confidence: 0,
				sampleCount: 0, explanation: "", learningState: "")
		}
	}
}
#endif
