import Foundation
import SwiftUI

enum ReaderSection: String, CaseIterable, Hashable, Identifiable, Sendable {
	case forYou
	case unread
	case starred

	var id: Self { self }

	var title: String {
		switch self {
		case .forYou: "For You"
		case .unread: "Unread"
		case .starred: "Starred"
		}
	}

	var systemImage: String {
		switch self {
		case .forYou: "sparkles"
		case .unread: "circle"
		case .starred: "star"
		}
	}

	var apiValue: String {
		switch self {
		case .forYou: "for-you"
		case .unread: "unread"
		case .starred: "starred"
		}
	}

	var keyboardKey: KeyEquivalent {
		switch self {
		case .forYou: "1"
		case .unread: "2"
		case .starred: "3"
		}
	}
}
