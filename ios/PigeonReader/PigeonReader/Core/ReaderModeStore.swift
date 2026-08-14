import Foundation

struct ReaderModeStore {
	private let defaults: UserDefaults
	private let keyPrefix = "pigeon.reader.mode."

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
	}

	func mode(for feedID: String) -> ReaderMode {
		guard let rawValue = defaults.string(forKey: key(for: feedID)),
			let mode = ReaderMode(rawValue: rawValue) else {
			return .feedContent
		}
		return mode
	}

	func setMode(_ mode: ReaderMode, for feedID: String) {
		defaults.set(mode.rawValue, forKey: key(for: feedID))
	}

	private func key(for feedID: String) -> String {
		keyPrefix + feedID
	}
}
