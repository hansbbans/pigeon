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
