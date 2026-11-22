import Foundation

nonisolated struct ReaderLocalDayBounds: Equatable, Sendable {
	let start: Date
	let end: Date

	nonisolated var startSeconds: Int {
		Int(start.timeIntervalSince1970)
	}

	nonisolated var endSeconds: Int {
		Int(end.timeIntervalSince1970)
	}

	nonisolated func contains(_ date: Date) -> Bool {
		date >= start && date < end
	}

	nonisolated static func localDay(containing date: Date, calendar: Calendar = .autoupdatingCurrent) -> Self {
		let start = calendar.startOfDay(for: date)
		let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start.addingTimeInterval(86_400)
		return Self(start: start, end: end)
	}

	/// `count` local days ending with the day that holds `date`: from midnight
	/// `count - 1` days before it to the next midnight. Counted in calendar
	/// days, so a week across a DST change is 7 days, not 7 × 86 400 s.
	nonisolated static func localDays(_ count: Int, endingWith date: Date, calendar: Calendar = .autoupdatingCurrent) -> Self {
		let day = localDay(containing: date, calendar: calendar)
		let start = calendar.date(byAdding: .day, value: -(max(count, 1) - 1), to: day.start) ?? day.start
		return Self(start: start, end: day.end)
	}
}
