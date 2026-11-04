import Foundation
import Testing
@testable import PigeonReader

/// The transcript document, the port of the web parser, and the follow logic.
struct YouTubeTranscriptTests {
	// MARK: - Parser (shared vectors with test/browser-transcript.test.ts)

	@Test func defuddleTextParsesToTheSharedVectors() throws {
		let bundle = Bundle(for: TranscriptBundleToken.self)
		let url = try #require(
			bundle.url(forResource: "defuddle-transcript-vectors", withExtension: "json", subdirectory: "transcript"),
			"Missing test/fixtures/transcript; is it a PigeonReaderTests resource?",
		)
		let file = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
		let vectors = try #require(file["vectors"] as? [[String: Any]])
		#expect(vectors.count >= 10)
		for vector in vectors {
			let name = vector["name"] as? String ?? "?"
			let parsed = YouTubeTranscript.parseDefuddle(vector["text"] as? String, language: vector["language"] as? String)
			if vector["expected"] is NSNull {
				#expect(parsed == nil, "\(name)")
				continue
			}
			let expected = try #require(vector["expected"] as? NSDictionary, "\(name)")
			let parsedJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try #require(parsed, "\(name)"))) as? NSDictionary
			#expect(parsedJSON == expected, "\(name): \(String(describing: parsedJSON))")
		}
	}

	@Test func encodingOmitsAbsentFields() throws {
		let transcript = YouTubeTranscript(segments: [.init(start: 1, text: "hi")])
		let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(transcript)) as? [String: Any])
		#expect(Set(json.keys) == ["version", "segments"])
		#expect((json["segments"] as? [[String: Any]])?.first?.keys.sorted() == ["start", "text"])
	}

	@Test func unknownFormatVersionsAreRefused() throws {
		let body = Data(#"{"version":2,"segments":[{"start":0,"text":"x"}]}"#.utf8)
		#expect(throws: YouTubeTranscriptFormatError.unsupportedVersion(2)) {
			try JSONDecoder().decode(YouTubeTranscript.self, from: body)
		}
	}

	// MARK: - Time and active segment (same cases as the web helpers)

	@Test func timesFormatLikeTheWeb() {
		#expect([0, 4.9, 65, 3599, 3600, 3725, -3, .nan].map(YouTubeTranscriptTime.format) == ["0:00", "0:04", "1:05", "59:59", "1:00:00", "1:02:05", "0:00", "0:00"])
		#expect(YouTubeTranscriptTime.spoken(65).contains("minute"))
	}

	@Test func activeSegmentIsTheLastOneStartedAtOrBeforeTheTime() {
		let starts: [Double] = [4, 6, 14]
		let times: [Double] = [0, 3.99, 4, 5.5, 6, 13.9, 14, 999, .nan]
		#expect(times.map { YouTubeTranscriptTime.activeIndex(starts: starts, time: $0) } == [nil, nil, 0, 0, 1, 1, 2, 2, nil])
		#expect(YouTubeTranscriptTime.activeIndex(starts: [], time: 10) == nil)
	}

	// MARK: - Following the player

	private static let transcript = YouTubeTranscript(segments: [
		.init(start: 4, duration: 2, text: "This is a 3."),
		.init(start: 6, duration: 8, text: "It's sloppily written."),
		.init(start: 14, text: "And I want you to take a moment."),
	])

	@Test func playbackHighlightsAndScrollsOnlyWhenTheSegmentChanges() {
		var follow = YouTubeTranscriptFollowState(transcript: Self.transcript)
		let now = Date(timeIntervalSince1970: 1_000)
		#expect(follow.update(time: 1, now: now) == .none, "before the first segment nothing is active")
		#expect(follow.update(time: 4.2, now: now) == .scroll(0))
		#expect(follow.update(time: 5.9, now: now) == .none, "same segment: no work")
		#expect(follow.update(time: 6, now: now) == .scroll(1))
		#expect(follow.activeIndex == 1)
		#expect(follow.update(time: 0, now: now) == .highlight(nil), "seeking before the start clears the highlight")
	}

	@Test func autoScrollPausesForFourSecondsAfterTheReaderScrolls() {
		var follow = YouTubeTranscriptFollowState(transcript: Self.transcript)
		let start = Date(timeIntervalSince1970: 1_000)
		follow.userScrolled(now: start)
		#expect(follow.update(time: 4, now: start.addingTimeInterval(1)) == .highlight(0))
		#expect(follow.update(time: 6, now: start.addingTimeInterval(3.99)) == .highlight(1))
		#expect(follow.update(time: 14, now: start.addingTimeInterval(4)) == .scroll(2))
	}

	@Test func tappingALineSeeksAndKeepsTheListWhereTheReaderPutIt() {
		var follow = YouTubeTranscriptFollowState(transcript: Self.transcript)
		let now = Date(timeIntervalSince1970: 1_000)
		#expect(follow.seek(to: 14, now: now) == 14)
		#expect(follow.activeIndex == 2)
		#expect(follow.allowsAutoScroll(now: now.addingTimeInterval(2)) == false)
		#expect(follow.update(time: 4, now: now.addingTimeInterval(1)) == .highlight(0))
		#expect(follow.seek(to: .nan, now: now) == nil)
		#expect(follow.seek(to: -1, now: now) == nil)
	}

	@Test func listRowsPutEachChapterBeforeItsFirstSegment() {
		let transcript = YouTubeTranscript(
			segments: [.init(start: 0, text: "a"), .init(start: 10, text: "b"), .init(start: 20, text: "c")],
			chapters: [.init(start: 10, title: "Two"), .init(start: 0, title: "One"), .init(start: 99, title: "After the end")],
		)
		#expect(YouTubeTranscriptList.Row.rows(for: transcript).map(\.id) == ["c0", "s0", "c1", "s1", "s2"])
	}

	// MARK: - Decoding the signal

	@Test func greaderItemsCarryTheTranscriptFlagOnlyWhenPresent() throws {
		let body = Data("""
		{"id":"feed/1","items":[
			{"id":"tag:google.com,2005:reader/item/0000000000000002","title":"Video","published":1,"categories":[],"alternate":[{"href":"https://www.youtube.com/watch?v=aircAruvnKk"}],"hasTranscript":true},
			{"id":"tag:google.com,2005:reader/item/0000000000000003","title":"Text","published":1,"categories":[],"alternate":[]},
			{"id":"tag:google.com,2005:reader/item/0000000000000004","title":"Odd","published":1,"categories":[],"alternate":[],"hasTranscript":"yes"}
		]}
		""".utf8)
		let items = try JSONDecoder().decode(ReaderStreamContentsResponse.self, from: body).items
		#expect(items.map(\.hasTranscript) == [true, nil, nil])
	}

	@Test func theFlagSurvivesTheArticleCacheEncoding() throws {
		var article = PreviewData.articles[0]
		article.hasTranscript = true
		let decoded = try JSONDecoder().decode(Recommendation.self, from: JSONEncoder().encode(article))
		#expect(decoded.hasTranscript == true)
		#expect(decoded.replacingHTML("<p>x</p>").hasTranscript == true)
		#expect(decoded.updatingSaved(title: "New").hasTranscript == true)
	}
}

private final class TranscriptBundleToken {}
