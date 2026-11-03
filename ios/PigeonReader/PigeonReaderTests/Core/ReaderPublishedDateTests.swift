import Foundation
import Testing
@testable import PigeonReader

struct ReaderPublishedDateTests {
	private let now = ISO8601DateFormatter().date(from: "2026-11-03T12:00:00Z")!

	private func iso(_ value: String) -> Date {
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)!
	}

	@Test
	func normalizesAbsoluteDatesToUTC() {
		#expect(ReaderPublishedDate.normalize("2026-10-01", now: now) == iso("2026-10-01T00:00:00Z"))
		#expect(ReaderPublishedDate.normalize("2026-10-01T09:30:00-04:00", now: now) == iso("2026-10-01T13:30:00Z"))
		#expect(ReaderPublishedDate.normalize("2024-01-26T14:42:42.000Z", now: now) == iso("2024-01-26T14:42:42.000Z"))
		#expect(ReaderPublishedDate.normalize("Tue, 14 Oct 2025 08:00:00 GMT", now: now) == iso("2025-10-14T08:00:00Z"))
	}

	@Test
	func dropsRelativeEmptyAndOutOfRangeValues() {
		for value in ["An hour ago", "Updated", "", "3000-01-01", "1989-12-31"] {
			#expect(ReaderPublishedDate.normalize(value, now: now) == nil, "\(value)")
		}
		#expect(ReaderPublishedDate.normalize(nil, now: now) == nil)
	}

	@Test
	func allowsUpToOneDayInTheFuture() {
		#expect(ReaderPublishedDate.normalize("2026-11-04T11:00:00Z", now: now) == iso("2026-11-04T11:00:00Z"))
		#expect(ReaderPublishedDate.normalize("2026-11-05T00:00:00Z", now: now) == nil)
	}

	@Test
	func readsNaiveAndLongFormDatesAsUTCLikeTheWebAndRejectsLooseText() {
		#expect(ReaderPublishedDate.normalize("2025-04-02T10:00:00", now: now) == iso("2025-04-02T10:00:00Z"))
		#expect(ReaderPublishedDate.normalize("April 2, 2025", now: now) == iso("2025-04-02T00:00:00Z"))
		#expect(ReaderPublishedDate.normalize("2 April 2025", now: now) == iso("2025-04-02T00:00:00Z"))
		for value in ["Updated 2025", "Tue 2021", "2025", "Posted on 2025-04-02 by Ada"] {
			#expect(ReaderPublishedDate.normalize(value, now: now) == nil, "\(value)")
		}
	}

	@Test @MainActor
	func defuddleSourceIsReadOnceAndShared() {
		let first = ReaderViewExtractor.bundledDefuddleSource()
		#expect(first?.isEmpty == false)
		#expect(ReaderViewExtractor.bundledDefuddleSource() == first)
	}
}

