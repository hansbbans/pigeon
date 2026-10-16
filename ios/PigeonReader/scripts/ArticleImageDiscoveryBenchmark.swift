import Foundation

/// From ios/PigeonReader, compile and run:
/// swiftc -O -o /tmp/pigeon-image-discovery-benchmark \
///   PigeonReader/Core/StructuredHTMLSanitizer.swift \
///   PigeonReader/Core/ReaderTypographySettings.swift \
///   PigeonReader/Core/ReaderFeedThumbnailSelection.swift \
///   PigeonReader/Features/Reader/ArticleRowThumbnailRequest.swift \
///   scripts/ArticleImageDiscoveryBenchmark.swift
/// /tmp/pigeon-image-discovery-benchmark
///
/// This isolates URL discovery formerly repeated on the main actor by each
/// visible row. It does not measure complete row rendering or device frame rate.
@main
struct ArticleImageDiscoveryBenchmark {
	static func main() {
		let paragraph = "<p class=\"newsletter-copy\">" + String(repeating: "Newsletter text &amp; facts. ", count: 10) + "</p>"
		for size in [10_000, 100_000, 500_000] {
			let html = "<article><img src=\"/hero.jpg\">"
				+ String(repeating: paragraph, count: size / paragraph.utf8.count) + "</article>"
			let request = ArticleRowThumbnailRequest(articleID: "story", html: html,
				baseURL: URL(string: "https://example.com/issue"), scope: "benchmark", policy: .normal, isImageRich: true)
			var previousTimes: [Double] = []
			var currentTimes: [Double] = []
			var checksum = 0
			for iteration in 0..<9 {
				let previous = measurePrevious(request)
				let current = measureCurrent(request)
				precondition(previous.1 == 2 && current.1 == 0)
				checksum += previous.1 + current.1
				if iteration >= 2 {
					previousTimes.append(previous.0)
					currentTimes.append(current.0)
				}
			}
			print(String(format: "%d bytes: previous %.3f ms/row update, current %.6f ms/row update; checksum %d",
				html.utf8.count, previousTimes.sorted()[3], currentTimes.sorted()[3], checksum))
		}
	}

	@inline(never)
	static func measurePrevious(_ request: ArticleRowThumbnailRequest) -> (Double, Int) {
		let start = ContinuousClock.now
		// Both the outer row and selectable content resolved their presentation.
		var count = 0
		for _ in 0..<2 {
			count += StructuredHTMLSanitizer.imageURLs(in: request.html, baseURL: request.baseURL).first == nil ? 0 : 1
		}
		return (milliseconds(since: start), count)
	}

	@inline(never)
	static func measureCurrent(_ request: ArticleRowThumbnailRequest) -> (Double, Int) {
		let start = ContinuousClock.now
		// Normal rows leave discovery to the existing bounded background pipeline.
		var count = 0
		for _ in 0..<2 { count += request.selectURL() == nil ? 0 : 1 }
		return (milliseconds(since: start), count)
	}

	static func milliseconds(since start: ContinuousClock.Instant) -> Double {
		let duration = start.duration(to: .now).components
		return Double(duration.seconds) * 1_000 + Double(duration.attoseconds) / 1e15
	}
}
