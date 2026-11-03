import Foundation
import Testing
@testable import PigeonReader

/// Same vectors as test/browser-reading-length.test.ts and test/word-count.test.ts,
/// so web and iOS label the same article the same way.
struct ReadingLengthTests {
	@Test
	func labelsOnlyItemsLongerThanTenMinutes() {
		func text(_ words: Int?, estimate: Int? = nil) -> String? {
			ReadingLength.label(wordCount: words, estimatedWordCount: estimate, mediaKind: nil, durationSeconds: nil)
		}
		func video(_ seconds: Int?, words: Int? = nil) -> String? {
			ReadingLength.label(wordCount: words, estimatedWordCount: nil, mediaKind: "video", durationSeconds: seconds)
		}
		#expect(text(1) == nil)
		#expect(text(2380) == nil)
		#expect(text(2381) == "11 min read")
		#expect(text(2856) == "12 min read")
		#expect(text(0) == nil)
		#expect(text(nil) == nil)
		#expect(text(nil, estimate: 3000) == "13 min read")
		#expect(text(5000, estimate: 10) == "22 min read")
		#expect(video(1080) == "18 min video")
		#expect(video(1100) == "19 min video")
		#expect(video(600) == nil)
		#expect(video(601) == "11 min video")
		#expect(video(20) == nil)
		#expect(video(3900) == "1 hr 5 min video")
		#expect(video(3901) == "1 hr 6 min video")
		#expect(video(7200) == "2 hr video")
		#expect(video(0, words: 9000) == nil)
	}

	@Test
	func reportsOnlyCountsThatBeatASnippet() {
		#expect(ReadingLength.shouldReport(stored: nil, extracted: 600, mediaKind: "text"))
		#expect(ReadingLength.shouldReport(stored: 100, extracted: 149, mediaKind: "text") == false)
		#expect(ReadingLength.shouldReport(stored: 100, extracted: 150, mediaKind: "text"))
		#expect(ReadingLength.shouldReport(stored: nil, extracted: 49, mediaKind: "text") == false)
		#expect(ReadingLength.shouldReport(stored: nil, extracted: 900, mediaKind: "video") == false)
		#expect(ReadingLength.shouldReport(stored: 0, extracted: 900, mediaKind: nil))
		#expect(ReadingLength.shouldReport(stored: nil, extracted: nil, mediaKind: nil) == false)
		#expect(ReadingLength.shouldReport(stored: nil, extracted: 2_000_000, mediaKind: nil))
		#expect(ReadingLength.shouldReport(stored: nil, extracted: 2_000_001, mediaKind: nil) == false)
	}

	@Test
	func countsWordsLikeTheWorkerScanner() {
		#expect(ReadingLength.countWords(inHTML: "<p>Hello <b>big</b> world</p>") == 3)
		#expect(ReadingLength.countWords(inHTML: "<p>one</p><p>two</p>") == 2)
		#expect(ReadingLength.countWords(inHTML: "<p>in<b>line</b></p>") == 2)
		#expect(ReadingLength.countWords(inHTML: "plain text without tags") == 4)
		#expect(ReadingLength.countWords(inHTML: "") == 0)
		let skipped = """
		<html><head><title>Ignored title words</title><style>p { color: red }</style></head>
		<body><!-- a hidden comment --><script>var x = "not words";</script>
		<template><p>template words</p></template><p>Visible words here</p></body></html>
		"""
		#expect(ReadingLength.countWords(inHTML: skipped) == 3)
		#expect(ReadingLength.countWords(inHTML: "a&nbsp;b") == 2)
		#expect(ReadingLength.countWords(inHTML: "a&#160;b&#xa0;c") == 3)
		#expect(ReadingLength.countWords(inHTML: "caf&eacute; &amp; bar") == 3)
		#expect(ReadingLength.countWords(inHTML: "a\u{00A0}b\u{2009}c\u{3000}d") == 4)
		#expect(ReadingLength.countWords(inHTML: "café naïve 日本語") == 3)
	}

	@Test
	func malformedMarkupDoesNotSwallowTheBody() {
		#expect(ReadingLength.countWords(inHTML: "<html><head><meta charset=\"utf-8\"><body><p>three body words</p></body>") == 3)
		#expect(ReadingLength.countWords(inHTML: "<head/><p>two words</p>") == 2)
		#expect(ReadingLength.countWords(inHTML: "<style>p{}<p>still counted here</p>") == 4)
		#expect(ReadingLength.countWords(inHTML: "<p>a < b and more</p>") == 5)
		#expect(ReadingLength.countWords(inHTML: "<p>ends with a <") == 4)
		#expect(ReadingLength.countWords(inHTML: "<!-- unterminated comment <p>two words</p>") == 2)
		// Case folding applies to letters only: a control byte is not a "-".
		#expect(ReadingLength.countWords(inHTML: "<!-- x -\r> hidden --><p>shown</p>") == 1)
	}

	@Test
	func capsTheScanAndStaysLinearOnMalformedMarkup() {
		#expect(ReadingLength.countWords(inHTML: "<p>" + String(repeating: "word ", count: 200_000) + "</p>") == 60_000)
		// The limit counts UTF-16 units like the web, not UTF-8 bytes.
		#expect(ReadingLength.countWords(inHTML: String(repeating: "слово ", count: 50_000)) == 50_000)
		#expect(ReadingLength.countWords(inHTML: String(repeating: "😀", count: 150_001)) == 1)
		for html in [
			String(repeating: "<a", count: 150_000),
			String(repeating: "<!--x>", count: 50_000),
			String(repeating: "<script x>", count: 30_000),
			String(repeating: "<style>", count: 40_000),
		] {
			let clock = ContinuousClock()
			let elapsed = clock.measure { _ = ReadingLength.countWords(inHTML: html) }
			#expect(elapsed < .seconds(1), "\(html.prefix(10))… took \(elapsed)")
		}
	}

	@Test
	func articleLengthIsNilWhenTheServerSentNothing() {
		#expect(ArticleLength(wordCount: nil, mediaKind: nil, durationSeconds: nil) == nil)
		#expect(ArticleLength(wordCount: nil, mediaKind: "video", durationSeconds: 1100)?.isVideo == true)
	}

	@Test @MainActor
	func articleLabelPrefersTheServerCountAndEstimatesOtherwise() {
		let body = "<p>" + String(repeating: "word ", count: 3000) + "</p>"
		let estimated = Self.article(id: "estimate", html: body)
		#expect(estimated.readingLengthLabel(showsReadingTime: true) == "13 min read")
		#expect(estimated.readingLengthLabel(showsReadingTime: false) == nil)

		var reported = Self.article(id: "reported", html: "<p>short snippet</p>")
		reported.length = ArticleLength(wordCount: 5000, mediaKind: "text", durationSeconds: nil)
		#expect(reported.readingLengthLabel(showsReadingTime: true) == "22 min read")

		var pruned = Self.article(id: "pruned", html: "")
		pruned = Recommendation(
			id: pruned.id, readerId: pruned.readerId, feedKey: pruned.feedKey, source: pruned.source, title: pruned.title,
			html: "", text: String(repeating: "word ", count: 3000), originalURL: pruned.originalURL, receivedAt: pruned.receivedAt,
			isRead: true, isStarred: false, score: 0, confidence: 0, sampleCount: 0, explanation: "", learningState: "",
		)
		#expect(pruned.readingLengthLabel(showsReadingTime: true) == "13 min read")

		var video = Self.article(id: "video", html: body)
		video.length = ArticleLength(wordCount: nil, mediaKind: "video", durationSeconds: 3900)
		#expect(video.readingLengthLabel(showsReadingTime: true) == "1 hr 5 min video")
	}

	private static func article(id: String, html: String) -> Recommendation {
		Recommendation(
			id: id,
			readerId: id,
			feedKey: "feed",
			source: "Source",
			title: "Title",
			html: html,
			text: nil,
			originalURL: URL(string: "https://example.com/story"),
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
