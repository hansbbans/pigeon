import Testing

@testable import PigeonReader

struct ReaderHTMLLayoutTests {
	@Test
	func capturesParagraphProgressAndRestoresItAfterImageOrTypographyChanges() throws {
		let original = ReaderHTMLLayout(
			contentHeight: 1_200,
			anchors: [
				ReaderSemanticAnchor(id: "p-1", top: 100, height: 80),
				ReaderSemanticAnchor(id: "p-2", top: 240, height: 100),
			],
		)
		let anchor = try #require(original.anchor(at: 290))
		#expect(anchor.id == "p-2")
		#expect(anchor.distanceFromTop == 50)

		let afterRelayout = ReaderHTMLLayout(
			contentHeight: 1_420,
			anchors: [
				ReaderSemanticAnchor(id: "p-1", top: 100, height: 80),
				ReaderSemanticAnchor(id: "p-2", top: 460, height: 100),
			],
		)
		#expect(afterRelayout.documentOffset(for: anchor) == 510)
	}

	@Test
	func clampsRestorationWhenTheParagraphBecameShorter() throws {
		let oldLayout = ReaderHTMLLayout(
			contentHeight: 1_000,
			anchors: [ReaderSemanticAnchor(id: "p", top: 200, height: 180)],
		)
		let anchor = try #require(oldLayout.anchor(at: 350))
		#expect(anchor.distanceFromTop == 150)

		let smallerParagraph = ReaderHTMLLayout(
			contentHeight: 600,
			anchors: [ReaderSemanticAnchor(id: "p", top: 200, height: 40)],
		)
		#expect(smallerParagraph.documentOffset(for: anchor) == 239)
	}

	@Test
	func preservesTheViewportBeforeTheFirstParagraph() throws {
		let oldLayout = ReaderHTMLLayout(
			contentHeight: 500,
			anchors: [ReaderSemanticAnchor(id: "first", top: 100, height: 60)],
		)
		let anchor = try #require(oldLayout.anchor(at: 0))
		#expect(anchor.id == "first")
		#expect(anchor.distanceFromTop == -100)

		let newLayout = ReaderHTMLLayout(
			contentHeight: 600,
			anchors: [ReaderSemanticAnchor(id: "first", top: 120, height: 60)],
		)
		#expect(newLayout.documentOffset(for: anchor) == 20)
	}

	@Test
	func keepsTheArticleHeaderVisibleWhenTheBodyStartsBelowTheViewport() throws {
		let layout = ReaderHTMLLayout(contentHeight: 900, anchors: [ReaderSemanticAnchor(id: "first", top: 0, height: 60)])
		let anchor = try #require(layout.anchor(at: -300))
		#expect(layout.documentOffset(for: anchor) == -300)
	}

	@Test
	func missingParagraphLeavesTheCallerFreeToUseDepthFallback() throws {
		let layout = ReaderHTMLLayout(
			contentHeight: 500,
			anchors: [ReaderSemanticAnchor(id: "p-2", top: 120, height: 60)],
		)
		let missing = ReaderScrollAnchor(id: "p-1", distanceFromTop: 10)
		#expect(layout.documentOffset(for: missing) == nil)
	}
}
