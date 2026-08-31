import Foundation

nonisolated enum FeedNotificationIdentity {
	static func ids(for subscription: FeedSubscription) -> Set<String> {
		Set([subscription.id, subscription.feedKey].filter { $0.isEmpty == false })
	}

	static func isEnabled(subscription: FeedSubscription, enabledIDs: Set<String>) -> Bool {
		ids(for: subscription).isDisjoint(with: enabledIDs) == false
	}

	static func shouldNotify(
		article: Recommendation,
		enabledIDs: Set<String>,
		subscriptions: [FeedSubscription],
	) -> Bool {
		if enabledIDs.contains(article.feedKey) {
			return true
		}
		return subscriptions.contains { subscription in
			isEnabled(subscription: subscription, enabledIDs: enabledIDs)
				&& ids(for: subscription).contains(article.feedKey)
		}
	}

	static func updatedIDs(
		_ enabledIDs: Set<String>,
		enabling: Bool,
		subscription: FeedSubscription,
	) -> Set<String> {
		let aliases = ids(for: subscription)
		if enabling {
			return enabledIDs.union(aliases)
		}
		return enabledIDs.subtracting(aliases)
	}

	static func expandedIDs(
		_ enabledIDs: Set<String>,
		subscriptions: [FeedSubscription],
	) -> Set<String> {
		subscriptions.reduce(into: enabledIDs) { result, subscription in
			guard isEnabled(subscription: subscription, enabledIDs: result) else {
				return
			}
			result.formUnion(ids(for: subscription))
		}
	}
}
