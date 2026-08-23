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
		storedMode(for: feedIDs) ?? .feedContent
	}

	func mode(for feedID: String, session: PigeonSession) -> ReaderMode {
		mode(for: [feedID], session: session)
	}

	func mode(for feedIDs: [String], session: PigeonSession) -> ReaderMode {
		storedMode(for: feedIDs, session: session) ?? .feedContent
	}

	func storedMode(for feedIDs: [String]) -> ReaderMode? {
		for feedID in uniqueFeedIDs(feedIDs) {
			if let stored = storedMode(for: feedID) {
				return stored
			}
		}
		return nil
	}

	func storedMode(for feedIDs: [String], session: PigeonSession) -> ReaderMode? {
		for feedID in uniqueFeedIDs(feedIDs) {
			if let stored = storedMode(for: feedID, session: session) {
				return stored
			}
		}
		return nil
	}

	func setMode(_ mode: ReaderMode, for feedID: String) {
		setMode(mode, for: [feedID])
	}

	func setMode(_ mode: ReaderMode, for feedIDs: [String]) {
		for feedID in uniqueFeedIDs(feedIDs) {
			defaults.set(mode.rawValue, forKey: key(for: feedID))
		}
	}

	func setMode(_ mode: ReaderMode, for feedID: String, session: PigeonSession) {
		setMode(mode, for: [feedID], session: session)
	}

	func setMode(_ mode: ReaderMode, for feedIDs: [String], session: PigeonSession) {
		for feedID in uniqueFeedIDs(feedIDs) {
			defaults.set(mode.rawValue, forKey: key(for: feedID, session: session))
		}
	}

	private func storedMode(for feedID: String) -> ReaderMode? {
		guard let rawValue = defaults.string(forKey: key(for: feedID)) else {
			return nil
		}
		return ReaderMode(rawValue: rawValue)
	}

	private func storedMode(for feedID: String, session: PigeonSession) -> ReaderMode? {
		guard let rawValue = defaults.string(forKey: key(for: feedID, session: session)) else {
			return nil
		}
		return ReaderMode(rawValue: rawValue)
	}

	private func uniqueFeedIDs(_ feedIDs: [String]) -> [String] {
		var seen = Set<String>()
		var unique: [String] = []
		for feedID in feedIDs {
			let trimmed = feedID.trimmingCharacters(in: .whitespacesAndNewlines)
			guard trimmed.isEmpty == false, seen.insert(trimmed).inserted else {
				continue
			}
			unique.append(trimmed)
		}
		return unique
	}

	private func key(for feedID: String) -> String {
		keyPrefix + feedID
	}

	private func key(for feedID: String, session: PigeonSession) -> String {
		keyPrefix + session.storageIdentity + "." + feedID
	}
}
