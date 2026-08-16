import Foundation
import UserNotifications

nonisolated enum ReaderNotificationAction: Codable, Equatable, Sendable {
	case open(articleID: String)
	case markRead(articleID: String)
	case star(articleID: String)
}

extension Notification.Name {
	static let pigeonReaderNotificationAction = Notification.Name("pigeon.reader.notification-action")
}

@MainActor
final class ReaderNotificationManager: NSObject, UNUserNotificationCenterDelegate {
	static let shared = ReaderNotificationManager()
	private static let categoryID = "PIGEON_ARTICLE"
	private static let markReadID = "PIGEON_MARK_READ"
	private static let starID = "PIGEON_STAR"
	private static let enabledFeedsKey = "pigeon.notifications.enabled-feeds.v1"
	nonisolated private static let pendingActionKey = "pigeon.notifications.pending-action.v1"
	private let center = UNUserNotificationCenter.current()

	private override init() {
		super.init()
		center.delegate = self
		let markRead = UNNotificationAction(identifier: Self.markReadID, title: "Mark Read", options: [])
		let star = UNNotificationAction(identifier: Self.starID, title: "Star", options: [])
		center.setNotificationCategories([
			UNNotificationCategory(identifier: Self.categoryID, actions: [markRead, star], intentIdentifiers: []),
		])
	}

	func requestAuthorization() async -> Bool {
		(try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
	}

	func isEnabled(feedID: String) -> Bool {
		enabledFeedIDs.contains(feedID)
	}

	func setEnabled(_ enabled: Bool, feedID: String) async -> Bool {
		if enabled, await requestAuthorization() == false { return false }
		var values = enabledFeedIDs
		if enabled { values.insert(feedID) } else { values.remove(feedID) }
		PigeonSharedData.defaults.set(Array(values).sorted(), forKey: Self.enabledFeedsKey)
		return true
	}

	func postNewArticle(_ article: Recommendation) async {
		guard isEnabled(feedID: article.feedKey) else { return }
		let content = UNMutableNotificationContent()
		content.title = article.source
		content.body = article.title
		content.sound = .default
		content.categoryIdentifier = Self.categoryID
		content.userInfo = ["articleID": article.id]
		content.threadIdentifier = article.feedKey
		content.targetContentIdentifier = article.id
		try? await center.add(UNNotificationRequest(identifier: "article:\(article.id)", content: content, trigger: nil))
	}

	func consumePendingAction() -> ReaderNotificationAction? {
		let defaults = PigeonSharedData.defaults
		guard let data = defaults.data(forKey: Self.pendingActionKey) else { return nil }
		defaults.removeObject(forKey: Self.pendingActionKey)
		return try? JSONDecoder().decode(ReaderNotificationAction.self, from: data)
	}

	private var enabledFeedIDs: Set<String> {
		Set(PigeonSharedData.defaults.stringArray(forKey: Self.enabledFeedsKey) ?? [])
	}

	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		willPresent notification: UNNotification,
		withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
	) {
		completionHandler([.banner, .list, .sound])
	}

	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		didReceive response: UNNotificationResponse,
		withCompletionHandler completionHandler: @escaping () -> Void
	) {
		defer { completionHandler() }
		guard let articleID = response.notification.request.content.userInfo["articleID"] as? String else { return }
		let action: ReaderNotificationAction
		switch response.actionIdentifier {
		case Self.markReadID: action = .markRead(articleID: articleID)
		case Self.starID: action = .star(articleID: articleID)
		default: action = .open(articleID: articleID)
		}
		Self.storePendingAction(action)
		Task { @MainActor in
			NotificationCenter.default.post(name: .pigeonReaderNotificationAction, object: action)
		}
	}

	nonisolated private static func storePendingAction(_ action: ReaderNotificationAction) {
		guard let data = try? JSONEncoder().encode(action) else { return }
		PigeonSharedData.defaults.set(data, forKey: pendingActionKey)
	}
}
