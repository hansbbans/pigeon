import Foundation

/// Normalizes an extractor's published date. Same rules as the web reader's
/// `normalizePublishedDate` (src/reader-published-date.ts): absolute dates
/// only, from 1990 to one day ahead; relative strings ("An hour ago") are nil.
nonisolated enum ReaderPublishedDate {
	private static let earliest = Date(timeIntervalSince1970: 631_152_000) // 1990-01-01T00:00:00Z

	static func normalize(_ value: String?, now: Date = .now) -> Date? {
		guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines),
			raw.isEmpty == false, raw.count <= 200,
			raw.range(of: #"\b(19|20)\d\d\b"#, options: .regularExpression) != nil,
			let date = parse(raw) else {
			return nil
		}
		guard date >= earliest, date <= now.addingTimeInterval(86_400) else { return nil }
		return date
	}

	private static func parse(_ value: String) -> Date? {
		let iso = ISO8601DateFormatter()
		for options: ISO8601DateFormatter.Options in [
			[.withInternetDateTime, .withFractionalSeconds],
			[.withInternetDateTime],
			[.withFullDate],
		] {
			iso.formatOptions = options
			if let date = iso.date(from: value) { return date }
		}
		let formatter = DateFormatter()
		formatter.locale = Locale(identifier: "en_US_POSIX")
		formatter.timeZone = TimeZone(identifier: "UTC")
		for format in ["EEE, dd MMM yyyy HH:mm:ss zzz", "dd MMM yyyy HH:mm:ss zzz", "yyyy-MM-dd'T'HH:mm:ss", "MMMM d, yyyy", "d MMMM yyyy"] {
			formatter.dateFormat = format
			if let date = formatter.date(from: value) { return date }
		}
		return nil
	}
}
