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

	func displayMode(for feedID: String, hasOriginalURL: Bool) -> ReaderMode {
		ReaderMode.displayMode(stored: mode(for: feedID), hasOriginalURL: hasOriginalURL)
	}

	func setMode(_ mode: ReaderMode, for feedID: String) {
		defaults.set(mode.rawValue, forKey: key(for: feedID))
	}

	func persistSelection(_ mode: ReaderMode, for feedID: String, hasOriginalURL: Bool) {
		guard ReaderMode.shouldPersistSelection(hasOriginalURL: hasOriginalURL) else {
			return
		}
		setMode(mode, for: feedID)
	}

	private func key(for feedID: String) -> String {
		keyPrefix + feedID
	}
}
