import Foundation
import SwiftUI

nonisolated enum ReaderSection: String, Codable, CaseIterable, Hashable, Identifiable, Sendable {
	case forYou
	case unread
	case starred
	/// Read It Later. Listed below Starred and always visible.
	case saved
	case today
	/// Today and the six local days before it, across all feeds.
	case lastSevenDays

	var id: Self { self }

	var title: String {
		switch self {
		case .forYou: "For You"
		case .today: "Today"
		case .lastSevenDays: "Last 7 Days"
		case .unread: "Unread"
		case .starred: "Starred"
		case .saved: SavedItems.title
		}
	}

	var systemImage: String {
		switch self {
		case .forYou: "sparkles"
		case .today: "calendar"
		case .lastSevenDays: "calendar.badge.clock"
		case .unread: "circle"
		case .starred: "star"
		case .saved: "bookmark"
		}
	}

	var apiValue: String {
		switch self {
		case .forYou: "for-you"
		case .today: "today"
		case .lastSevenDays: "last-7-days"
		case .unread: "unread"
		case .starred: "starred"
		case .saved: "saved"
		}
	}

	var keyboardKey: KeyEquivalent {
		switch self {
		case .forYou: "1"
		case .unread: "2"
		case .starred: "3"
		case .today: "4"
		case .saved: "5"
		case .lastSevenDays: "6"
		}
	}

	/// The local days a time-window view covers at `now`: Today is the day
	/// holding `now`, Last 7 Days that day and the six before it, counted in
	/// calendar days so a week across a DST change stays seven days. Nil for
	/// views that are not bounded by time.
	func dayWindow(at now: Date, calendar: Calendar = .autoupdatingCurrent) -> ReaderLocalDayBounds? {
		switch self {
		case .today: ReaderLocalDayBounds.localDay(containing: now, calendar: calendar)
		case .lastSevenDays: ReaderLocalDayBounds.lastSevenDays(endingWith: now, calendar: calendar)
		case .forYou, .unread, .starred, .saved: nil
		}
	}

	/// Views whose membership is a local-day window over the reading list.
	static let dayWindowSections: [ReaderSection] = [.today, .lastSevenDays]

	var usesDayWindow: Bool {
		Self.dayWindowSections.contains(self)
	}

	var usesRecommendationEndpoint: Bool {
		self == .forYou
	}

	/// Read It Later is not a Smart View setting; it is always listed.
	var isAlwaysVisible: Bool {
		self == .saved
	}

	var streamExcludeTag: String? {
		self == .unread ? "user/-/state/com.google/read" : nil
	}
}
