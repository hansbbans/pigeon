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
}
