import Foundation
import Testing
@testable import PigeonReader

@MainActor
struct ArticleReaderControlsTests {
	@Test func bottomBarKeepsRecEngineInTheStarSlotAndReadwiseFifth() {
		#expect(ArticleReaderControl.allCases == [
			.markRead,
			.recEngine,
			.share,
			.readingControls,
			.shareToReadwise,
		])
		#expect(ArticleReaderControl.recEngine.title == "More like this")
		#expect(ArticleReaderControl.recEngine.systemImage == "sparkles")
		#expect(ArticleReaderControl.shareToReadwise.title == "Share to Readwise")
		#expect(ArticleReaderControl.shareToReadwise.systemImage == "bookmark")
	}

	@Test func readingControlsMenuLeadsWithTextSizeThenLineHeight() {
		#expect(ArticleReaderReadingAdjustment.allCases == [
			.largerText,
			.smallerText,
			.looserLines,
			.tighterLines,
		])
		#expect(ArticleReaderControl.readingControls.systemImage == "textformat.size")
		#expect(ArticleReaderReadingAdjustment.largerText.title == "Larger text")
		#expect(ArticleReaderReadingAdjustment.smallerText.title == "Smaller text")
		#expect(ArticleReaderReadingAdjustment.largerText.systemImage == "textformat.size.larger")
		#expect(ArticleReaderReadingAdjustment.smallerText.systemImage == "textformat.size.smaller")
	}

	@Test func readingAdjustmentsDisableAtTypographyBounds() {
		#expect(
			ArticleReaderReadingAdjustment.largerText.isEnabled(
				textScale: ReaderTypographySettings.textScaleRange.upperBound,
				lineHeight: ReaderTypographySettings.defaultLineHeight,
			) == false
		)
		#expect(
			ArticleReaderReadingAdjustment.smallerText.isEnabled(
				textScale: ReaderTypographySettings.textScaleRange.lowerBound,
				lineHeight: ReaderTypographySettings.defaultLineHeight,
			) == false
		)
		#expect(
			ArticleReaderReadingAdjustment.largerText.isEnabled(
				textScale: ReaderTypographySettings.defaultTextScale,
				lineHeight: ReaderTypographySettings.defaultLineHeight,
			)
		)
		#expect(
			ArticleReaderReadingAdjustment.looserLines.isEnabled(
				textScale: ReaderTypographySettings.defaultTextScale,
				lineHeight: ReaderTypographySettings.lineHeightRange.upperBound,
			) == false
		)
		#expect(
			ArticleReaderReadingAdjustment.tighterLines.isEnabled(
				textScale: ReaderTypographySettings.defaultTextScale,
				lineHeight: ReaderTypographySettings.lineHeightRange.lowerBound,
			) == false
		)
	}

	@Test func markReadTitleAndIconFollowReadState() {
		#expect(ArticleReaderControl.markRead.title(isRead: false) == "Mark read")
		#expect(ArticleReaderControl.markRead.systemImage(isRead: false) == "largecircle.fill.circle")
		#expect(ArticleReaderControl.markRead.title(isRead: true) == "Mark unread")
		#expect(ArticleReaderControl.markRead.systemImage(isRead: true) == "circle")
	}

	@Test func shareUsesTheOriginalURLWhenTheStoryHasOne() throws {
		let url = try #require(URL(string: "https://example.com/cities"))
		let article = makeShareArticle(
			title: "A short note on cities",
			html: "<p>Compact systems reward clear hierarchy.</p>",
			text: "Compact systems reward clear hierarchy.",
			originalURL: url,
		)

		#expect(ArticleShareItem.make(from: article) == .url(url))
	}

	@Test func shareFallsBackToTitleSourceAndBodyWhenTheStoryHasNoURL() {
		let article = makeShareArticle(
			title: "Sunday Notes",
			html: "<p>A useful paragraph &amp; a second thought.</p><p>Keep going.</p>",
			text: nil,
			originalURL: nil,
		)

		#expect(
			ArticleShareItem.make(from: article) == .text(
				"Sunday Notes\nDaily\n\nA useful paragraph & a second thought.\n\nKeep going."
			)
		)
	}

	@Test func shareUsesHTMLWhenPlainTextIsBlank() {
		let article = makeShareArticle(
			title: "Sunday Notes",
			html: "<p>From the newsletter HTML.</p>",
			text: "   ",
			originalURL: nil,
		)

		#expect(
			ArticleShareItem.make(from: article) == .text(
				"Sunday Notes\nDaily\n\nFrom the newsletter HTML."
			)
		)
	}

	@Test func sharePrefersPlainTextOverHTMLWhenTheStoryHasNoURL() {
		let article = makeShareArticle(
			title: "Sunday Notes",
			html: "<p>HTML that should stay unused.</p>",
			text: "The newsletter as plain text.",
			originalURL: nil,
		)

		#expect(
			ArticleShareItem.make(from: article) == .text(
				"Sunday Notes\nDaily\n\nThe newsletter as plain text."
			)
		)
	}

	@Test func shareIgnoresNonHTTPOriginalURLsAndStillSharesText() throws {
		let article = makeShareArticle(
			title: "Sunday Notes",
			html: "<p>Newsletter body.</p>",
			text: "Newsletter body.",
			originalURL: URL(string: "ftp://example.com/not-shareable"),
		)

		#expect(article.safeOriginalURL == nil)
		#expect(
			ArticleShareItem.make(from: article) == .text(
				"Sunday Notes\nDaily\n\nNewsletter body."
			)
		)
	}

	@Test func delayedSaveCannotPresentAfterArticleNavigation() async throws {
		let url = try #require(URL(string: "https://example.com/article"))
		let destination = try #require(OutboundDestination(url: url))
		let saveState = ArticleReaderControlsSaveState()
		let request = saveState.begin(articleID: "first-article", destination: destination)
		#expect(saveState.isSaving)
		let delayedSave = DelayedReadwiseSave()
		let completion = Task { @MainActor () -> Bool in
			await delayedSave.wait()
			return saveState.complete(request, with: "Saved to Reader.")
		}

		await delayedSave.waitUntilWaiting()
		saveState.articleDidChange(to: "next-article")
		#expect(saveState.isSaving == false)
		#expect(saveState.isShowingSaveMessage == false)
		#expect(saveState.saveMessage == nil)

		await delayedSave.resolve()
		#expect(await completion.value == false)
		#expect(saveState.isSaving == false)
		#expect(saveState.isShowingSaveMessage == false)
		#expect(saveState.saveMessage == nil)
	}
}

private actor DelayedReadwiseSave {
	private var continuation: CheckedContinuation<Void, Never>?
	private var waitingContinuations: [CheckedContinuation<Void, Never>] = []
	private var isWaiting = false

	func wait() async {
		isWaiting = true
		let waiters = waitingContinuations
		waitingContinuations.removeAll()
		for waiter in waiters {
			waiter.resume()
		}

		await withCheckedContinuation { continuation in
			self.continuation = continuation
		}
	}

	func waitUntilWaiting() async {
		guard isWaiting == false else {
			return
		}

		await withCheckedContinuation { continuation in
			waitingContinuations.append(continuation)
		}
	}

	func resolve() {
		continuation?.resume()
		continuation = nil
	}
}

private func makeShareArticle(
	title: String,
	html: String,
	text: String?,
	originalURL: URL?,
) -> Recommendation {
	Recommendation(
		id: "share-article",
		readerId: "tag:google.com,2005:reader/item/share-article",
		feedKey: "daily",
		source: "Daily",
		title: title,
		html: html,
		text: text,
		originalURL: originalURL,
		receivedAt: Date(timeIntervalSince1970: 1_786_272_000),
		isRead: false,
		isStarred: false,
		score: 0,
		confidence: 0,
		sampleCount: 0,
		explanation: "From Daily",
		learningState: "Reader subscription",
	)
}
