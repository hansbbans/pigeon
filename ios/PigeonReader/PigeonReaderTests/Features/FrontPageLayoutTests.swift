import Foundation
import Testing
@testable import PigeonReader

struct FrontPageLayoutTests {
	@Test(arguments: [0, 1, 12, 13, 14, 26, 30])
	func pagesKeepEveryStoryOnceInCollectionOrder(count: Int) {
		let articles = (0..<count).map { Self.article("story-\($0)") }
		let pages = FrontPageLayout.pages(for: articles)

		let flattened = pages.flatMap { [$0.lead] + $0.grid }
		#expect(flattened.map(\.id) == articles.map(\.id))
		#expect(pages.count == (count + FrontPageLayout.storiesPerPage - 1) / FrontPageLayout.storiesPerPage)
		#expect(pages.allSatisfy { $0.grid.count <= FrontPageLayout.storiesPerPage - 1 })
	}

	@Test
	func leadIsAlwaysTheFirstStoryOfItsPageSoReadingDoesNotReshuffle() {
		var articles = (0..<14).map { Self.article("story-\($0)") }
		let before = FrontPageLayout.pages(for: articles)
		articles[0].isRead = true

		let after = FrontPageLayout.pages(for: articles)
		#expect(before.map(\.lead.id) == ["story-0", "story-13"])
		#expect(after.map(\.lead.id) == before.map(\.lead.id))
		#expect(after.map(\.id) == before.map(\.id))
	}

	@Test
	func gridUsesOneColumnOnlyForNarrowColumnsAndLargeText() {
		// Before the first measurement the grid assumes a phone.
		#expect(FrontPageLayout.gridColumnCount(availableWidth: nil, usesAccessibilitySize: false, isVerticallyCompact: false) == 2)
		#expect(FrontPageLayout.gridColumnCount(availableWidth: 402, usesAccessibilitySize: false, isVerticallyCompact: false) == 2)
		#expect(FrontPageLayout.gridColumnCount(availableWidth: 375, usesAccessibilitySize: false, isVerticallyCompact: false) == 2)
		// A 320pt iPad list column.
		#expect(FrontPageLayout.gridColumnCount(availableWidth: 320, usesAccessibilitySize: false, isVerticallyCompact: false) == 1)
		#expect(FrontPageLayout.gridColumnCount(availableWidth: 402, usesAccessibilitySize: true, isVerticallyCompact: false) == 1)
	}

	@Test
	func wideWindowsGetASpreadWithThreeColumns() {
		// iPhone portrait and an iPad mini column keep the single-column page.
		#expect(FrontPageLayout.usesSpread(availableWidth: nil, usesAccessibilitySize: false, isVerticallyCompact: false) == false)
		#expect(FrontPageLayout.usesSpread(availableWidth: 402, usesAccessibilitySize: false, isVerticallyCompact: false) == false)
		#expect(FrontPageLayout.usesSpread(availableWidth: 744, usesAccessibilitySize: false, isVerticallyCompact: false) == false)
		// iPad Pro 11-inch, portrait and landscape.
		#expect(FrontPageLayout.usesSpread(availableWidth: 834, usesAccessibilitySize: false, isVerticallyCompact: false))
		#expect(FrontPageLayout.usesSpread(availableWidth: 1194, usesAccessibilitySize: false, isVerticallyCompact: false))
		// Large text keeps the stacked lead and one column.
		#expect(FrontPageLayout.usesSpread(availableWidth: 1194, usesAccessibilitySize: true, isVerticallyCompact: false) == false)

		#expect(FrontPageLayout.gridColumnCount(availableWidth: 834, usesAccessibilitySize: false, isVerticallyCompact: false) == 3)
		#expect(FrontPageLayout.gridColumnCount(availableWidth: 1194, usesAccessibilitySize: false, isVerticallyCompact: false) == 3)
		#expect(FrontPageLayout.gridColumnCount(availableWidth: 1194, usesAccessibilitySize: true, isVerticallyCompact: false) == 1)

		// A Pro Max phone in landscape is wide enough but too short: it keeps
		// the stacked page with its banner lead.
		#expect(FrontPageLayout.usesSpread(availableWidth: 956, usesAccessibilitySize: false, isVerticallyCompact: true) == false)
		#expect(FrontPageLayout.gridColumnCount(availableWidth: 956, usesAccessibilitySize: false, isVerticallyCompact: true) == 2)

		#expect(FrontPageLayout.maximumContentWidth(usesSpread: false) == 640)
		#expect(FrontPageLayout.maximumContentWidth(usesSpread: true) == 1080)
	}

	@Test
	func deckCollapsesWhitespaceAndStaysBounded() {
		#expect(FrontPageLayout.deck(from: nil) == nil)
		#expect(FrontPageLayout.deck(from: " \n\t ") == nil)
		#expect(FrontPageLayout.deck(from: "  Markets\n\n fell   today.\t") == "Markets fell today.")
		let long = String(repeating: "word ", count: 500)
		#expect((FrontPageLayout.deck(from: long, limit: 40)?.count ?? 0) == 40)
		#expect(FrontPageLayout.deck(from: "Café ☕️ naïve", limit: 6) == "Café ☕️")
	}

	@Test
	func editorialImagesRejectSpacersLogosAndBanners() {
		#expect(FrontPageLayout.isEditorialImage(width: 960, height: 640, minimumWidth: 320))
		#expect(FrontPageLayout.isEditorialImage(width: 600, height: 900, minimumWidth: 320))
		#expect(FrontPageLayout.isEditorialImage(width: 1, height: 1, minimumWidth: 140) == false)
		#expect(FrontPageLayout.isEditorialImage(width: 200, height: 150, minimumWidth: 320) == false)
		#expect(FrontPageLayout.isEditorialImage(width: 960, height: 120, minimumWidth: 320) == false)
		#expect(FrontPageLayout.isEditorialImage(width: 400, height: 0, minimumWidth: 140) == false)
	}

	@Test
	func kickerColorsAreStableAcrossLaunches() {
		// Fixed FNV-1a values: a per-launch seeded hash would fail these.
		#expect(FrontPageKickerPalette.colorIndex(for: "") == 5)
		#expect(FrontPageKickerPalette.colorIndex(for: "abc") == 3)
		#expect(FrontPageKickerPalette.colorIndex(for: "money-stuff") == 0)
		let indices = (0..<200).map { FrontPageKickerPalette.colorIndex(for: "feed-\($0)") }
		#expect(indices.allSatisfy { (0..<FrontPageKickerPalette.count).contains($0) })
		#expect(Set(indices).count == FrontPageKickerPalette.count)
	}

	private static func article(_ id: String) -> Recommendation {
		Recommendation(
			id: id,
			readerId: id,
			feedKey: "feed",
			source: "Source",
			title: "Title \(id)",
			html: "",
			text: "Text",
			originalURL: URL(string: "https://example.com/\(id)"),
			receivedAt: Date(timeIntervalSince1970: 0),
			isRead: false,
			isStarred: false,
			score: 0,
			confidence: 0,
			sampleCount: 0,
			explanation: "",
			learningState: "",
		)
	}
}
