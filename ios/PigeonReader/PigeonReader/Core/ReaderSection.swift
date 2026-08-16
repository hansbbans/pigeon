import Foundation
import SwiftUI

nonisolated enum ReaderSection: String, Codable, CaseIterable, Hashable, Identifiable, Sendable {
	case forYou
	case unread
	case starred
	case today

	var id: Self { self }

	var title: String {
		switch self {
		case .forYou: "For You"
		case .today: "Today"
		case .unread: "Unread"
		case .starred: "Starred"
		}
	}

	var systemImage: String {
		switch self {
		case .forYou: "sparkles"
		case .today: "calendar"
		case .unread: "circle"
		case .starred: "star"
		}
	}

	var apiValue: String {
		switch self {
		case .forYou: "for-you"
		case .today: "today"
		case .unread: "unread"
		case .starred: "starred"
		}
	}

	var keyboardKey: KeyEquivalent {
		switch self {
		case .forYou: "1"
		case .unread: "2"
		case .starred: "3"
		case .today: "4"
		}
	}

	var usesRecommendationEndpoint: Bool {
		self != .today
	}
}
