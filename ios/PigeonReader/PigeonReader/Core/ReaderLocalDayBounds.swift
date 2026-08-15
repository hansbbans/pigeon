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
}
