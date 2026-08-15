import Foundation

enum ReaderModeIdentity {
	static func aliases(
		for feedID: String,
		navigationItems: [ReaderNavigationItem],
		subscriptions: [FeedSubscription] = [],
	) -> [String] {
		var seen = Set<String>()
		var aliases: [String] = []

		func append(_ value: String?) {
			guard let value else {
				return
			}
			let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
			guard trimmed.isEmpty == false, seen.insert(trimmed).inserted else {
				return
			}
			aliases.append(trimmed)
		}

		append(feedID)

		for item in navigationItems where item.kind == .feed {
			guard itemMatches(item, feedID: feedID) else {
				continue
			}
			append(item.streamID)
			append(item.feedKey)
		}

		for subscription in subscriptions {
			guard subscription.id == feedID || subscription.feedKey == feedID else {
				continue
			}
			append(subscription.id)
			append(subscription.feedKey)
		}

		return aliases
	}

	private static func itemMatches(_ item: ReaderNavigationItem, feedID: String) -> Bool {
		item.id == feedID
			|| item.streamID == feedID
			|| item.feedKey == feedID
			|| item.id.hasPrefix("\(feedID)::")
	}
}

struct ReaderModeStore {
	private let defaults: UserDefaults
	private let keyPrefix = "pigeon.reader.mode."

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
	}

	func mode(for feedID: String) -> ReaderMode {
		mode(for: [feedID])
	}

	func mode(for feedIDs: [String]) -> ReaderMode {
		var seen = Set<String>()
		for feedID in feedIDs {
			let trimmed = feedID.trimmingCharacters(in: .whitespacesAndNewlines)
			guard trimmed.isEmpty == false, seen.insert(trimmed).inserted else {
				continue
			}
			if let stored = storedMode(for: trimmed) {
				return stored
			}
		}
		return .feedContent
	}

	func setMode(_ mode: ReaderMode, for feedID: String) {
		setMode(mode, for: [feedID])
	}

	func setMode(_ mode: ReaderMode, for feedIDs: [String]) {
		var seen = Set<String>()
		for feedID in feedIDs {
			let trimmed = feedID.trimmingCharacters(in: .whitespacesAndNewlines)
			guard trimmed.isEmpty == false, seen.insert(trimmed).inserted else {
				continue
			}
			defaults.set(mode.rawValue, forKey: key(for: trimmed))
		}
	}

	private func storedMode(for feedID: String) -> ReaderMode? {
		guard let rawValue = defaults.string(forKey: key(for: feedID)) else {
			return nil
		}
		return ReaderMode(rawValue: rawValue)
	}

	private func key(for feedID: String) -> String {
		keyPrefix + feedID
	}
}
