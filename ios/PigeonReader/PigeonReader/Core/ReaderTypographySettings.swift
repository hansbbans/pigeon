import Foundation
import Observation

@MainActor
@Observable
final class ReaderTypographySettings {
	static let textScaleRange = 0.85...1.35
	static let lineHeightRange = 1.25...1.85
	static let defaultTextScale = 1.0
	static let defaultLineHeight = 1.55

	private let defaults: UserDefaults
	private let textScaleKey = "pigeon.reader.typography.text-scale"
	private let lineHeightKey = "pigeon.reader.typography.line-height"
	private var storedTextScale: Double
	private var storedLineHeight: Double

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
		storedTextScale = Self.clamp(
			defaults.object(forKey: textScaleKey) as? Double ?? Self.defaultTextScale,
			to: Self.textScaleRange,
		)
		storedLineHeight = Self.clamp(
			defaults.object(forKey: lineHeightKey) as? Double ?? Self.defaultLineHeight,
			to: Self.lineHeightRange,
		)
	}

	var textScale: Double {
		get { storedTextScale }
		set {
			storedTextScale = Self.clamp(newValue, to: Self.textScaleRange)
			defaults.set(storedTextScale, forKey: textScaleKey)
		}
	}

	var lineHeight: Double {
		get { storedLineHeight }
		set {
			storedLineHeight = Self.clamp(newValue, to: Self.lineHeightRange)
			defaults.set(storedLineHeight, forKey: lineHeightKey)
		}
	}

	func increaseTextScale() {
		textScale += 0.05
	}

	func decreaseTextScale() {
		textScale -= 0.05
	}

	func increaseLineHeight() {
		lineHeight += 0.05
	}

	func decreaseLineHeight() {
		lineHeight -= 0.05
	}

	func reset() {
		textScale = Self.defaultTextScale
		lineHeight = Self.defaultLineHeight
	}

	private static func clamp(_ value: Double, to range: ClosedRange<Double>) -> Double {
		min(max(value, range.lowerBound), range.upperBound)
	}
}
