import Foundation
import SwiftUI

nonisolated enum ReaderSection: String, Codable, CaseIterable, Hashable, Identifiable, Sendable {
	case forYou
	case unread
	case starred
	/// Read It Later. Listed below Starred and always visible.
	case saved
	case today

	var id: Self { self }

	var title: String {
		switch self {
		case .forYou: "For You"
		case .today: "Today"
		case .unread: "Unread"
		case .starred: "Starred"
		case .saved: SavedItems.title
		}
	}

	var systemImage: String {
		switch self {
		case .forYou: "sparkles"
		case .today: "calendar"
		case .unread: "circle"
		case .starred: "star"
		case .saved: "bookmark"
		}
	}

	var apiValue: String {
		switch self {
		case .forYou: "for-you"
		case .today: "today"
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
		}
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
