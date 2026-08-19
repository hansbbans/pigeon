import Foundation
import Observation
import SwiftUI

nonisolated enum ReaderArticleKeyboardShortcut: String, CaseIterable, Codable, Identifiable, Sendable {
	case j
	case k
	case downArrow = "down-arrow"
	case upArrow = "up-arrow"
	case rightArrow = "right-arrow"
	case leftArrow = "left-arrow"
	case pageDown = "page-down"
	case pageUp = "page-up"

	var id: Self { self }

	var title: String {
		switch self {
		case .j: "J"
		case .k: "K"
		case .downArrow: "Down Arrow"
		case .upArrow: "Up Arrow"
		case .rightArrow: "Right Arrow"
		case .leftArrow: "Left Arrow"
		case .pageDown: "Page Down"
		case .pageUp: "Page Up"
		}
	}

	var keyEquivalent: KeyEquivalent {
		switch self {
		case .j: "j"
		case .k: "k"
		case .downArrow: .downArrow
		case .upArrow: .upArrow
		case .rightArrow: .rightArrow
		case .leftArrow: .leftArrow
		case .pageDown: .pageDown
		case .pageUp: .pageUp
		}
	}

	var keyboardShortcut: KeyboardShortcut {
		KeyboardShortcut(keyEquivalent, modifiers: [])
	}
}

nonisolated enum ReaderArticleKeyboardShortcutAction: Sendable {
	case next
	case previous
}

@MainActor
@Observable
final class ReaderKeyboardShortcutSettings {
	static let nextKey = "pigeon.reader.keyboard-shortcut.next.v1"
	static let previousKey = "pigeon.reader.keyboard-shortcut.previous.v1"

	static let defaultNext: ReaderArticleKeyboardShortcut = .j
	static let defaultPrevious: ReaderArticleKeyboardShortcut = .k

	private let defaults: UserDefaults
	private var storedNext: ReaderArticleKeyboardShortcut
	private var storedPrevious: ReaderArticleKeyboardShortcut

	init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
		let next = defaults.string(forKey: Self.nextKey)
			.flatMap(ReaderArticleKeyboardShortcut.init(rawValue:)) ?? Self.defaultNext
		let previous = defaults.string(forKey: Self.previousKey)
			.flatMap(ReaderArticleKeyboardShortcut.init(rawValue:)) ?? Self.defaultPrevious
		storedNext = next
		storedPrevious = previous == next ? Self.availableShortcut(excluding: next) : previous
		persist()
	}

	var next: ReaderArticleKeyboardShortcut {
		get { storedNext }
		set { set(newValue, for: .next) }
	}

	var previous: ReaderArticleKeyboardShortcut {
		get { storedPrevious }
		set { set(newValue, for: .previous) }
	}

	func set(_ shortcut: ReaderArticleKeyboardShortcut, for action: ReaderArticleKeyboardShortcutAction) {
		switch action {
		case .next:
			guard shortcut != storedNext else { return }
			if shortcut == storedPrevious {
				storedPrevious = storedNext
			}
			storedNext = shortcut
		case .previous:
			guard shortcut != storedPrevious else { return }
			if shortcut == storedNext {
				storedNext = storedPrevious
			}
			storedPrevious = shortcut
		}
		persist()
	}

	func reset() {
		storedNext = Self.defaultNext
		storedPrevious = Self.defaultPrevious
		persist()
	}

	private func persist() {
		defaults.set(storedNext.rawValue, forKey: Self.nextKey)
		defaults.set(storedPrevious.rawValue, forKey: Self.previousKey)
	}

	private static func availableShortcut(excluding excluded: ReaderArticleKeyboardShortcut) -> ReaderArticleKeyboardShortcut {
		ReaderArticleKeyboardShortcut.allCases.first(where: { $0 != excluded }) ?? defaultPrevious
	}
}
