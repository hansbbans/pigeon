#if DEBUG
import Foundation

/// `-reader-cards-fixture`: a "Newsletters" folder of five feeds plus one feed
/// in no folder, with stories from today, the last week and a month ago, so
/// the Cards look shows every kind of card. Dates are relative to launch.
nonisolated enum PreviewCardsFixture {
	static var isEnabled: Bool {
		ProcessInfo.processInfo.arguments.contains("-reader-cards-fixture")
	}

	static let folderID = "user/-/label/Newsletters"
	static let folderLabel = "Newsletters"

	struct Feed: Sendable {
		let key: String
		let title: String
		let inFolder: Bool
		var streamID: String { "feed/\(key)" }
	}

	struct Story: Sendable {
		let feed: Feed
		let number: Int
		let title: String
		let hoursAgo: Double
		let isRead: Bool
		var id: String { "\(feed.streamID)-story-\(number)" }
	}

	static let feeds = [
		Feed(key: "cards-dense", title: "Dense Discovery", inFolder: true),
		Feed(key: "cards-strat", title: "Stratechery", inFolder: true),
		Feed(key: "cards-money", title: "Money Stuff", inFolder: true),
		Feed(key: "cards-browser", title: "The Browser", inFolder: true),
		Feed(key: "cards-platformer", title: "Platformer", inFolder: true),
		Feed(key: "cards-kottke", title: "Kottke", inFolder: false),
	]

	static func stories() -> [Story] {
		let dense = feeds[0], strat = feeds[1], money = feeds[2], browser = feeds[3], platformer = feeds[4], kottke = feeds[5]
		// Today's stories are minutes old, so they stay today however early the launch.
		return [
			Story(feed: strat, number: 1, title: "The Aggregator's dilemma, revisited for an age of agents", hoursAgo: 0.1, isRead: false),
			Story(feed: dense, number: 1, title: "Issue 312: Quiet tools, loud cities", hoursAgo: 0.15, isRead: false),
			Story(feed: money, number: 1, title: "The bond market wants a word", hoursAgo: 0.2, isRead: true),
			Story(feed: platformer, number: 1, title: "Inside the moderation team that runs on spreadsheets", hoursAgo: 0.25, isRead: false),
			Story(feed: strat, number: 2, title: "An interview about chips, power and the next data centre", hoursAgo: 0.3, isRead: false),
			Story(feed: money, number: 2, title: "Private credit, public questions", hoursAgo: 0.35, isRead: false),
			Story(feed: strat, number: 3, title: "Why bundles come back", hoursAgo: 0.4, isRead: false),
			Story(feed: kottke, number: 1, title: "A map of every lighthouse in the world", hoursAgo: 0.45, isRead: false),
			Story(feed: dense, number: 2, title: "A field guide to slower software", hoursAgo: 30, isRead: false),
			Story(feed: money, number: 3, title: "Who owns the index?", hoursAgo: 50, isRead: false),
			Story(feed: platformer, number: 2, title: "The week the feeds went quiet", hoursAgo: 52, isRead: true),
			Story(feed: strat, number: 4, title: "Paywalls and the open web", hoursAgo: 75, isRead: false),
			Story(feed: dense, number: 3, title: "Issue 311: Libraries of things", hoursAgo: 100, isRead: false),
			Story(feed: platformer, number: 3, title: "What a social network owes its moderators", hoursAgo: 120, isRead: false),
			Story(feed: money, number: 4, title: "Everything is securities fraud, again", hoursAgo: 130, isRead: false),
			Story(feed: dense, number: 4, title: "Issue 310: The repair economy", hoursAgo: 260, isRead: true),
			Story(feed: browser, number: 1, title: "The long afterlife of a forgotten encyclopedia", hoursAgo: 480, isRead: false),
			Story(feed: browser, number: 2, title: "On the joy of reading timetables", hoursAgo: 500, isRead: false),
			Story(feed: kottke, number: 2, title: "Ten thousand hours of birdsong", hoursAgo: 30, isRead: false),
		]
	}

	static func streamIDs(_ stream: String?) -> [String] {
		guard let stream else { return [] }
		return stories().filter { story in
			stream == story.feed.streamID
				|| (stream == folderID && story.feed.inFolder)
				|| stream == "user/-/state/com.google/reading-list"
		}
		.map(\.id)
	}

	/// Answers library and stream requests; nil leaves the request to the
	/// normal preview client.
	static func data(for request: URLRequest) throws -> Data? {
		guard isEnabled, let url = request.url else { return nil }
		let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
		switch url.path {
		case "/reader/api/0/subscription/list":
			return try JSONSerialization.data(withJSONObject: ["subscriptions": feeds.map { feed in
				[
					"id": feed.streamID, "title": feed.title,
					"categories": feed.inFolder ? [["id": folderID, "label": folderLabel]] : [],
					"url": "https://pigeon.preview/feed/\(feed.key)",
				] as [String: Any]
			}])
		case "/reader/api/0/unread-count":
			let unread = stories().filter { $0.isRead == false }
			var counts = feeds.map { feed in
				["id": feed.streamID, "count": unread.count(where: { $0.feed.key == feed.key })] as [String: Any]
			}
			counts.append(["id": folderID, "count": unread.count(where: \.feed.inFolder)])
			counts.append(["id": "user/-/state/com.google/reading-list", "count": unread.count])
			return try JSONSerialization.data(withJSONObject: ["unreadcounts": counts])
		case "/reader/api/0/stream/items/ids":
			let stream = query.first { $0.name == "s" }?.value
			let excludesRead = query.contains { $0.name == "xt" && $0.value == "user/-/state/com.google/read" }
			let readIDs = Set(stories().filter(\.isRead).map(\.id))
			let ids = streamIDs(stream).filter { excludesRead == false || readIDs.contains($0) == false }
			return try JSONSerialization.data(withJSONObject: ["itemRefs": ids.map { ["id": $0] }])
		case "/reader/api/0/stream/items/contents":
			let form = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
			let requested = Set(URLComponents(string: "https://pigeon.preview/?\(form)")?.queryItems?
				.filter { $0.name == "i" }.compactMap(\.value) ?? [])
			let now = Date.now
			let items: [[String: Any]] = stories().filter { requested.contains($0.id) }.map { story in
				[
					"id": story.id, "title": story.title,
					"published": Int(now.addingTimeInterval(-story.hoursAgo * 3_600).timeIntervalSince1970),
					"summary": ["content": "<p>\(story.title). A fixture story for the Cards look.</p>"],
					"alternate": [["href": "https://example.com/\(story.id)"]],
					"origin": ["streamId": story.feed.streamID, "title": story.feed.title],
					"categories": story.isRead ? ["user/-/state/com.google/read"] : [],
				]
			}
			guard let stream = (items.first?["origin"] as? [String: Any])?["streamId"] else { return nil }
			return try JSONSerialization.data(withJSONObject: ["id": stream, "items": items])
		default:
			return nil
		}
	}
}
#endif
