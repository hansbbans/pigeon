import SwiftUI

enum ReaderMotion {
	static let folderExpansionDuration = 0.26

	static func animation(reduceMotion: Bool) -> Animation {
		reduceMotion ? .easeOut(duration: 0.12) : .snappy(duration: 0.24, extraBounce: 0)
	}

	static func folderExpansion(reduceMotion: Bool, duration: Double? = nil) -> Animation? {
		guard reduceMotion == false else { return nil }
		let duration = duration ?? folderExpansionDuration
		guard duration > 0 else { return nil }
		return .snappy(duration: duration, extraBounce: 0)
	}

	static func feedSwitch(reduceMotion: Bool) -> Animation {
		.easeInOut(duration: reduceMotion ? 0.12 : 0.18)
	}

	static func contentArrival(reduceMotion: Bool) -> Animation {
		.easeOut(duration: reduceMotion ? 0.08 : 0.16)
	}
}
