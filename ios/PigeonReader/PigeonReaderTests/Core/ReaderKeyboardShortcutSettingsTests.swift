import Foundation
import Testing
@testable import PigeonReader

@MainActor
struct ReaderKeyboardShortcutSettingsTests {
	@Test
	func defaultsAreJForNextAndKForPrevious() throws {
		let suiteName = "pigeon-reader-keyboard-shortcuts-defaults-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }

		let settings = ReaderKeyboardShortcutSettings(defaults: defaults)

		#expect(settings.next == .j)
		#expect(settings.previous == .k)
		#expect(defaults.string(forKey: ReaderKeyboardShortcutSettings.nextKey) == "j")
		#expect(defaults.string(forKey: ReaderKeyboardShortcutSettings.previousKey) == "k")
	}

	@Test
	func shortcutsPersistAcrossSettingsInstances() throws {
		let suiteName = "pigeon-reader-keyboard-shortcuts-persistence-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }

		let settings = ReaderKeyboardShortcutSettings(defaults: defaults)
		settings.next = .pageDown
		settings.previous = .pageUp

		let restored = ReaderKeyboardShortcutSettings(defaults: defaults)
		#expect(restored.next == .pageDown)
		#expect(restored.previous == .pageUp)
	}

	@Test
	func assigningAConflictingShortcutSwapsTheOtherActionDeterministically() throws {
		let suiteName = "pigeon-reader-keyboard-shortcuts-conflict-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: suiteName))
		defer { defaults.removePersistentDomain(forName: suiteName) }

		let settings = ReaderKeyboardShortcutSettings(defaults: defaults)
		settings.next = .downArrow
		settings.previous = .downArrow

		#expect(settings.next == .k)
		#expect(settings.previous == .downArrow)
	}
}
