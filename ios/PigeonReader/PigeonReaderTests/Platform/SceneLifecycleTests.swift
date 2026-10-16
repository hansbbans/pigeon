import Foundation
import SwiftUI
import Testing
@testable import PigeonReader

struct SceneLifecycleTests {
	@Test func sceneLifecyclePolicyKeepsBackgroundingOnAFlushPath() {
		#expect(SceneLifecyclePolicy.action(for: .active) == .becomeActive)
		#expect(SceneLifecyclePolicy.action(for: .inactive) == .resignActive)
		#expect(SceneLifecyclePolicy.action(for: .background) == .flushInBackground)
	}

	@Test func widgetSnapshotBuilderRunsOffTheMainActorAndDeduplicatesAliases() async {
		let canonical = WidgetSnapshotArticleRecord(
			id: "canonical",
			readerId: "tag:google.com,2005:reader/item/aa",
			title: "Canonical",
			source: "Daily",
			receivedAt: Date(timeIntervalSince1970: 30),
			isRead: false,
			isStarred: true,
		)
		let alias = WidgetSnapshotArticleRecord(
			id: "tag:google.com,2005:reader/item/aa",
			readerId: "canonical",
			title: "Alias",
			source: "Daily",
			receivedAt: Date(timeIntervalSince1970: 20),
			isRead: false,
			isStarred: true,
		)
		let older = WidgetSnapshotArticleRecord(
			id: "older",
			readerId: "older",
			title: "Older",
			source: "Daily",
			receivedAt: Date(timeIntervalSince1970: 10),
			isRead: false,
			isStarred: false,
		)
		let readForYou = WidgetSnapshotArticleRecord(
			id: "read-foryou",
			readerId: "read-foryou",
			title: "Read",
			source: "Daily",
			receivedAt: Date(timeIntervalSince1970: 40),
			isRead: true,
			isStarred: false,
		)
		let unreadForYou = WidgetSnapshotArticleRecord(
			id: "unread-foryou",
			readerId: "unread-foryou",
			title: "Unread For You",
			source: "Daily",
			receivedAt: Date(timeIntervalSince1970: 5),
			isRead: false,
			isStarred: false,
		)
		let input = WidgetSnapshotInput(
			articlesByCollection: [
				ReaderSection.unread.rawValue: [canonical, alias, older],
				ReaderSection.today.rawValue: [canonical],
				ReaderSection.forYou.rawValue: [readForYou, unreadForYou],
				ReaderSection.starred.rawValue: [canonical, alias],
			],
			unreadCount: 8,
			starredUnreadCount: 1,
			starredHasMore: false,
			previousStarredCount: nil,
			generatedAt: Date(timeIntervalSince1970: 50),
		)

		let snapshot = await Task.detached(priority: .utility) {
			WidgetSnapshotBuilder.make(input)
		}.value

		#expect(snapshot.unreadCount == 8)
		#expect(snapshot.starredCount == 1)
		#expect(snapshot.recent.map(\.id) == ["canonical", "older"])
		#expect(snapshot.recent.first?.deepLink == PigeonDeepLink.article("canonical", collection: ReaderSection.today.rawValue).url)
		#expect(snapshot.forYou.map(\.id) == ["unread-foryou"])
		#expect(snapshot.forYou.first?.deepLink == PigeonDeepLink.article("unread-foryou", collection: ReaderSection.forYou.rawValue).url)
	}

	@Test func cachedLibrarySnapshotPreparationSortsOffTheMainActor() async {
		let newer = Recommendation(
			id: "newer",
			readerId: "newer",
			feedKey: "daily",
			source: "Daily",
			title: "Newer",
			html: "<p>Newer</p>",
			text: nil,
			originalURL: nil,
			receivedAt: Date(timeIntervalSince1970: 20),
			isRead: false,
			isStarred: false,
			score: 1,
			confidence: 0,
			sampleCount: 0,
			explanation: "Test",
			learningState: "Test",
		)
		let older = Recommendation(
			id: "older",
			readerId: "older",
			feedKey: "daily",
			source: "Daily",
			title: "Older",
			html: "<p>Older</p>",
			text: nil,
			originalURL: nil,
			receivedAt: Date(timeIntervalSince1970: 10),
			isRead: false,
			isStarred: false,
			score: 1,
			confidence: 0,
			sampleCount: 0,
			explanation: "Test",
			learningState: "Test",
		)
		let prepared = await Task.detached(priority: .utility) {
			CachedLibrarySnapshotPreparation.sortedArticlesByCollection(
				[ReaderSection.unread.rawValue: [older, newer]],
				sortOrders: [ReaderSection.unread.rawValue: .newest],
				canonicalOrder: [:],
			)
		}.value

		#expect(prepared[ReaderSection.unread.rawValue]?.map(\.id) == ["newer", "older"])

		let recommended = await Task.detached(priority: .utility) {
			CachedLibrarySnapshotPreparation.sortedArticlesByCollection(
				["feed": [newer, older]],
				sortOrders: ["feed": .recommended],
				canonicalOrder: ["feed": ["older", "newer"]],
			)
		}.value
		#expect(recommended["feed"]?.map(\.id) == ["older", "newer"])
	}
}

@MainActor
final class RecordingSceneBackgroundTaskRunner: SceneBackgroundTaskRunning {
	private(set) var beginCount = 0
	private(set) var endCount = 0
	private(set) var names: [String] = []
	private var nextRawValue = 1

	func beginTask(name: String, expirationHandler: @escaping @Sendable () -> Void) -> SceneBackgroundTaskID {
		beginCount += 1
		names.append(name)
		defer { nextRawValue += 1 }
		return SceneBackgroundTaskID(rawValue: nextRawValue)
	}

	func endTask(_ identifier: SceneBackgroundTaskID) {
		endCount += 1
		_ = identifier
	}
}
