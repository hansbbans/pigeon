import Foundation

nonisolated enum ReaderNavigationCatalog {
	static func make(
		subscriptions: [ReaderSubscription],
		unreadCounts: [ReaderUnreadCount],
		smartCounts: ReaderNavigationSmartCounts,
	) -> ReaderNavigationState {
		let countsByID = Dictionary(uniqueKeysWithValues: unreadCounts.map { ($0.id, max($0.count, 0)) })
		let feedCounts = unreadCounts.reduce(into: [String: Int]()) { result, count in
			guard count.id.hasPrefix("feed/") else {
				return
			}
			result[count.id] = max(count.count, 0)
		}
		var folderItemsByID: [String: ReaderNavigationItem] = [:]
		var folderFallbackCounts: [String: Int] = [:]
		var childItems: [ReaderNavigationItem] = []
		var uncategorizedItems: [ReaderNavigationItem] = []

		for subscription in subscriptions.sorted(by: sortByTitle) {
			let categories = uniqueCategories(subscription.categories)
			if categories.isEmpty {
				uncategorizedItems.append(
					makeFeedItem(
						subscription: subscription,
						parentID: nil,
						feedID: subscription.id,
						unreadCount: feedCounts[subscription.id, default: 0],
					),
				)
				continue
			}

			for category in categories {
				let folderID = category.id
				if folderItemsByID[folderID] == nil {
					folderItemsByID[folderID] = ReaderNavigationItem(
						id: folderID,
						title: categoryTitle(category),
						streamID: folderID,
						kind: .folder,
						unreadCount: 0,
						parentID: nil,
						feedKey: nil,
						iconURL: nil,
						smartSection: nil,
					)
				}
				// A feed contributes once per unique folder label. Duplicate labels are removed above,
				// so a feed with several labels cannot be counted twice inside one folder.
				folderFallbackCounts[folderID, default: 0] += feedCounts[subscription.id, default: 0]
				childItems.append(
					makeFeedItem(
						subscription: subscription,
						parentID: folderID,
						feedID: "\(subscription.id)::\(folderID)",
						unreadCount: feedCounts[subscription.id, default: 0],
					),
				)
			}
		}

		let folderItems = folderItemsByID.values
			.map { folder in
				let count = countsByID[folder.id] ?? folderFallbackCounts[folder.id, default: 0]
				return ReaderNavigationItem(
					id: folder.id,
					title: folder.title,
					streamID: folder.streamID,
					kind: folder.kind,
					unreadCount: count,
					parentID: folder.parentID,
					feedKey: folder.feedKey,
					iconURL: folder.iconURL,
					smartSection: folder.smartSection,
				)
			}
			.sorted(by: sortByTitle)

		let smartItems = ReaderSection.allCases.map { section in
			let count: Int
			switch section {
			case .forYou: count = smartCounts.forYou
			case .today: count = smartCounts.today
			case .unread: count = smartCounts.unread
			case .starred: count = smartCounts.starred
			}
			return ReaderNavigationItem.smart(section, unreadCount: count)
		}

		return ReaderNavigationState(items: smartItems + folderItems + childItems.sorted(by: sortByTitle) + uncategorizedItems.sorted(by: sortByTitle))
	}

	static func uniqueCategories(_ categories: [ReaderSubscriptionCategory]) -> [ReaderSubscriptionCategory] {
		var seen = Set<String>()
		return categories
			.filter { category in
				let id = category.id.trimmingCharacters(in: .whitespacesAndNewlines)
				guard id.isEmpty == false else {
					return false
				}
				return seen.insert(id).inserted
			}
			.sorted { left, right in
				let leftTitle = categoryTitle(left)
				let rightTitle = categoryTitle(right)
				let titleComparison = leftTitle.localizedStandardCompare(rightTitle)
				if titleComparison != .orderedSame {
					return titleComparison == .orderedAscending
				}
				return left.id < right.id
			}
	}

	private static func categoryTitle(_ category: ReaderSubscriptionCategory) -> String {
		if let label = category.label?.trimmingCharacters(in: .whitespacesAndNewlines), label.isEmpty == false {
			return label
		}
		let prefix = "user/-/label/"
		return category.id.hasPrefix(prefix) ? String(category.id.dropFirst(prefix.count)) : category.id
	}

	private static func makeFeedItem(
			subscription: ReaderSubscription,
		parentID: String?,
		feedID: String,
		unreadCount: Int,
	) -> ReaderNavigationItem {
		ReaderNavigationItem(
			id: feedID,
			title: subscription.title,
			streamID: subscription.id,
			kind: .feed,
			unreadCount: unreadCount,
			parentID: parentID,
			feedKey: feedKey(from: subscription),
			iconURL: subscription.iconURL.flatMap(URL.init(string:)),
			smartSection: nil,
		)
	}

	private static func feedKey(from subscription: ReaderSubscription) -> String? {
		guard let rawURL = subscription.url, let url = URL(string: rawURL) else {
			return nil
		}
		let components = url.path.split(separator: "/")
		guard let feedIndex = components.lastIndex(of: "feed"), components.index(after: feedIndex) < components.endIndex else {
			return nil
		}
		return String(components[components.index(after: feedIndex)])
	}

	private static func sortByTitle(_ left: ReaderNavigationItem, _ right: ReaderNavigationItem) -> Bool {
		localizedTitle(left.title, before: right.title) || (left.title.compare(right.title, options: .caseInsensitive) == .orderedSame && left.id < right.id)
	}

	private static func sortByTitle(_ left: ReaderSubscription, _ right: ReaderSubscription) -> Bool {
		localizedTitle(left.title, before: right.title) || (left.title.compare(right.title, options: .caseInsensitive) == .orderedSame && left.id < right.id)
	}

	private static func localizedTitle(_ left: String, before right: String) -> Bool {
		left.localizedStandardCompare(right) == .orderedAscending
	}
}
