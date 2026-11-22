import Foundation
import Observation

nonisolated enum ReaderTheme: String, CaseIterable, Identifiable, Sendable {
	case system
	case light
	case darkGray = "dark-gray"
	case dark
	case sepia

	var id: Self { self }
	var title: String {
		switch self {
		case .system: "System"
		case .light: "Light"
		case .darkGray: "Dark Gray"
		case .dark: "Black"
		case .sepia: "Sepia"
		}
	}
}

/// The reading typeface for story titles and article text. UI chrome stays in the system font.
nonisolated enum ReaderTypeface: String, CaseIterable, Identifiable, Sendable {
	case geistSerif = "geist-serif"
	case bookerly
	case allo

	var id: Self { self }
	var title: String {
		switch self {
		case .geistSerif: "Geist Serif"
		case .bookerly: "Bookerly"
		case .allo: "Allo"
		}
	}
}

nonisolated enum ReaderRemoteImagePolicy: String, CaseIterable, Identifiable, Sendable {
	case normal
	case blocked
	case privacyProxied = "privacy-proxied"

	var id: Self { self }
	var title: String {
		switch self {
		case .normal: "Load Normally"
		case .blocked: "Ask Before Loading"
		case .privacyProxied: "Privacy Proxy"
		}
	}
}

nonisolated enum ReaderTimelineDensity: String, CaseIterable, Identifiable, Sendable {
	case titleOnly = "title-only"
	case compact
	case comfortable
	case imageRich = "image-rich"

	var id: Self { self }
	var title: String {
		switch self {
		case .titleOnly: "Title Only"
		case .compact: "Compact"
		case .comfortable: "Comfortable"
		case .imageRich: "Image Rich"
		}
	}
}

/// The app's two looks, chosen per device. Cards: Home tiles, folders and
/// feeds as cards, smart views as the Front Page, and a regular window that
/// navigates page by page. Reeder: the story list in a split view.
nonisolated enum ReaderLook: String, CaseIterable, Identifiable, Sendable {
	case cards
	case reeder

	var id: Self { self }
	var title: String {
		switch self {
		case .cards: "Cards"
		case .reeder: "Reeder"
		}
	}

	/// The look a device had before the setting existed: Front Page became
	/// Cards and Classic became Reeder. Nothing stored means Cards.
	static func migrated(fromLegacyHomeLayout legacy: String?) -> Self {
		legacy == "classic" ? .reeder : .cards
	}
}

nonisolated enum ReaderMarkReadBehavior: String, CaseIterable, Identifiable, Sendable {
	case manually
	case onOpen = "on-open"
	case onScroll = "on-scroll"

	var id: Self { self }
	var title: String {
		switch self {
		case .manually: "Manually"
		case .onOpen: "When Opened"
		case .onScroll: "After 60% Read"
		}
	}
}

@MainActor
@Observable
final class ReaderTypographySettings {
	nonisolated static let textScaleRange = 0.85...1.35
	nonisolated static let lineHeightRange = 1.25...1.85
	static let horizontalMarginRange = 8.0...56.0
	static let columnWidthRange = 480.0...920.0
	static let defaultTextScale = 1.0
	static let defaultLineHeight = 1.55
	static let defaultHorizontalMargin = 20.0
	static let defaultColumnWidth = 640.0

	private let defaults: UserDefaults
	private let textScaleKey = "pigeon.reader.typography.text-scale"
	private let lineHeightKey = "pigeon.reader.typography.line-height"
	private let horizontalMarginKey = "pigeon.reader.typography.horizontal-margin"
	private let columnWidthKey = "pigeon.reader.typography.column-width"
	private let themeKey = "pigeon.reader.theme"
	static let typefaceKey = "pigeon.reader.typography.typeface"
	private let imagePolicyKey = "pigeon.reader.remote-images"
	private let densityKey = "pigeon.reader.timeline-density"
	private let markReadBehaviorKey = "pigeon.reader.mark-read-behavior"
	static let lookKey = "pigeon.reader.look.v1"
	/// `ReaderHomeLayout` (classic / front-page), read once to migrate to the look.
	static let legacyHomeLayoutKey = "pigeon.reader.home-layout.v1"
	static let showsReadingTimeKey = "pigeon.reader.shows-reading-time"
	private var storedTextScale: Double
	private var storedLineHeight: Double
	private var storedHorizontalMargin: Double
	private var storedColumnWidth: Double
	private var storedTheme: ReaderTheme
	private var storedTypeface: ReaderTypeface
	private var storedImagePolicy: ReaderRemoteImagePolicy
	private var storedDensity: ReaderTimelineDensity
	private var storedMarkReadBehavior: ReaderMarkReadBehavior
	private var storedLook: ReaderLook
	private var storedShowsReadingTime: Bool

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
		storedHorizontalMargin = Self.clamp(
			defaults.object(forKey: horizontalMarginKey) as? Double ?? Self.defaultHorizontalMargin,
			to: Self.horizontalMarginRange,
		)
		storedColumnWidth = Self.clamp(
			defaults.object(forKey: columnWidthKey) as? Double ?? Self.defaultColumnWidth,
			to: Self.columnWidthRange,
		)
		storedTheme = defaults.string(forKey: themeKey).flatMap(ReaderTheme.init(rawValue:)) ?? .system
		storedTypeface = defaults.string(forKey: Self.typefaceKey).flatMap(ReaderTypeface.init(rawValue:)) ?? .geistSerif
		storedImagePolicy = defaults.string(forKey: imagePolicyKey).flatMap(ReaderRemoteImagePolicy.init(rawValue:)) ?? .normal
		storedDensity = defaults.string(forKey: densityKey).flatMap(ReaderTimelineDensity.init(rawValue:)) ?? .comfortable
		storedMarkReadBehavior = defaults.string(forKey: markReadBehaviorKey).flatMap(ReaderMarkReadBehavior.init(rawValue:)) ?? .onOpen
		if let look = defaults.string(forKey: Self.lookKey).flatMap(ReaderLook.init(rawValue:)) {
			storedLook = look
		} else if let legacy = defaults.string(forKey: Self.legacyHomeLayoutKey) {
			let look = ReaderLook.migrated(fromLegacyHomeLayout: legacy)
			storedLook = look
			defaults.set(look.rawValue, forKey: Self.lookKey)
			defaults.removeObject(forKey: Self.legacyHomeLayoutKey)
		} else {
			storedLook = .cards
		}
		storedShowsReadingTime = defaults.object(forKey: Self.showsReadingTimeKey) as? Bool ?? true
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

	var horizontalMargin: Double {
		get { storedHorizontalMargin }
		set {
			storedHorizontalMargin = Self.clamp(newValue, to: Self.horizontalMarginRange)
			defaults.set(storedHorizontalMargin, forKey: horizontalMarginKey)
		}
	}

	var columnWidth: Double {
		get { storedColumnWidth }
		set {
			storedColumnWidth = Self.clamp(newValue, to: Self.columnWidthRange)
			defaults.set(storedColumnWidth, forKey: columnWidthKey)
		}
	}

	var theme: ReaderTheme {
		get { storedTheme }
		set {
			storedTheme = newValue
			defaults.set(newValue.rawValue, forKey: themeKey)
		}
	}

	var typeface: ReaderTypeface {
		get { storedTypeface }
		set {
			storedTypeface = newValue
			defaults.set(newValue.rawValue, forKey: Self.typefaceKey)
		}
	}

	var remoteImagePolicy: ReaderRemoteImagePolicy {
		get { storedImagePolicy }
		set {
			storedImagePolicy = newValue
			defaults.set(newValue.rawValue, forKey: imagePolicyKey)
		}
	}

	var timelineDensity: ReaderTimelineDensity {
		get { storedDensity }
		set {
			storedDensity = newValue
			defaults.set(newValue.rawValue, forKey: densityKey)
		}
	}

	var markReadBehavior: ReaderMarkReadBehavior {
		get { storedMarkReadBehavior }
		set {
			storedMarkReadBehavior = newValue
			defaults.set(newValue.rawValue, forKey: markReadBehaviorKey)
		}
	}

	var look: ReaderLook {
		get { storedLook }
		set {
			storedLook = newValue
			defaults.set(newValue.rawValue, forKey: Self.lookKey)
		}
	}

	/// Shows "12 min read" / "1 hr 5 min video" on articles over 10 minutes.
	var showsReadingTime: Bool {
		get { storedShowsReadingTime }
		set {
			storedShowsReadingTime = newValue
			defaults.set(newValue, forKey: Self.showsReadingTimeKey)
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
		horizontalMargin = Self.defaultHorizontalMargin
		columnWidth = Self.defaultColumnWidth
		theme = .system
		typeface = .geistSerif
	}

	private static func clamp(_ value: Double, to range: ClosedRange<Double>) -> Double {
		min(max(value, range.lowerBound), range.upperBound)
	}
}
