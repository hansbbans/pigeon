import Foundation

/// One printed "page" of the Front Page layout: a lead story above a grid.
nonisolated struct FrontPagePage: Equatable, Identifiable, Sendable {
	let lead: Recommendation
	let grid: [Recommendation]

	var id: String { lead.id }
}

/// Front Page keeps the collection's order. The lead is always the first story
/// of its page, so reading a story never reshuffles the page under the reader.
nonisolated enum FrontPageLayout {
	static let storiesPerPage = 13
	static let topAnchorID = "front-page-top"
	/// Below this width two columns leave too little room for a headline.
	static let twoColumnMinimumWidth = 330.0
	/// From this width (an iPad Pro 11-inch in portrait) the page is a spread:
	/// the lead image sits beside its headline and the grid is three across.
	/// An iPad mini in portrait (744) keeps the phone page, and so does a
	/// phone in landscape however wide it is: its window is too short for a
	/// spread, so it keeps the banner lead.
	static let spreadMinimumWidth = 760.0

	static func usesSpread(availableWidth: Double?, usesAccessibilitySize: Bool, isVerticallyCompact: Bool) -> Bool {
		guard usesAccessibilitySize == false, isVerticallyCompact == false, let availableWidth else { return false }
		return availableWidth >= spreadMinimumWidth
	}

	/// A stacked page stops at 640 so its lead image stays on one screen; a
	/// spread stops where a three-column line is still comfortable to read.
	static func maximumContentWidth(usesSpread: Bool) -> Double {
		usesSpread ? 1080 : 640
	}

	/// Stories across in the grid under each lead.
	static func gridColumnCount(availableWidth: Double?, usesAccessibilitySize: Bool, isVerticallyCompact: Bool) -> Int {
		if usesAccessibilitySize { return 1 }
		guard let availableWidth else { return 2 }
		if usesSpread(availableWidth: availableWidth, usesAccessibilitySize: false, isVerticallyCompact: isVerticallyCompact) {
			return 3
		}
		return availableWidth < twoColumnMinimumWidth ? 1 : 2
	}

	static func pages(for articles: [Recommendation]) -> [FrontPagePage] {
		stride(from: 0, to: articles.count, by: storiesPerPage).map { start in
			let end = min(start + storiesPerPage, articles.count)
			return FrontPagePage(lead: articles[start], grid: Array(articles[(start + 1)..<end]))
		}
	}

	/// A short standfirst from the story's plain text, with whitespace collapsed.
	static func deck(from text: String?, limit: Int = 240) -> String? {
		guard let text else { return nil }
		// Bound the work before splitting: decks only ever show a few lines.
		let words = text.prefix(limit * 2).split(whereSeparator: \.isWhitespace)
		guard words.isEmpty == false else { return nil }
		let collapsed = words.joined(separator: " ")
		return collapsed.count > limit ? String(collapsed.prefix(limit)) : collapsed
	}

	/// Newsletters often open with a logo, spacer, or banner. Only images with
	/// some size and a photo-like shape earn space on the page.
	static func isEditorialImage(width: Int, height: Int, minimumWidth: Int) -> Bool {
		guard width >= minimumWidth, height > 0 else { return false }
		let aspect = Double(width) / Double(height)
		return (0.6...2.4).contains(aspect)
	}
}

/// Stable colour assignment for the sender kicker above each headline.
nonisolated enum FrontPageKickerPalette {
	static let count = 8

	/// FNV-1a over UTF-8. Swift's `hashValue` is seeded per launch, which would
	/// repaint every newsletter on each run.
	static func colorIndex(for feedKey: String) -> Int {
		var hash: UInt64 = 0xcbf2_9ce4_8422_2325
		for byte in feedKey.utf8 {
			hash ^= UInt64(byte)
			hash &*= 0x0000_0100_0000_01b3
		}
		return Int(hash % UInt64(count))
	}
}
