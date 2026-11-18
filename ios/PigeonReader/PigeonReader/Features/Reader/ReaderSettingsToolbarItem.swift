import SwiftUI

/// The way back to Home from a regular-width split view. A compact window
/// already has the navigation stack's back button.
struct ReaderHomeToolbarItem: ToolbarContent {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.readerWindowHorizontalSizeClass) private var windowHorizontalSizeClass

	var body: some ToolbarContent {
		if windowHorizontalSizeClass == .regular {
			ToolbarItem(placement: .topBarLeading) {
				Button("Home", systemImage: "square.grid.2x2") {
					model.showHome()
				}
				.accessibilityIdentifier(ReaderHomeAccessibility.showHome)
				.accessibilityHint("Returns to Home")
			}
		}
	}
}

struct ReaderSettingsToolbarItem: ToolbarContent {
	@Environment(ReaderAppModel.self) private var model

	var body: some ToolbarContent {
		ToolbarItem(placement: .topBarTrailing) {
			Button("Settings", systemImage: "gearshape") {
				model.isShowingSettings = true
			}
			.keyboardShortcut(",", modifiers: .command)
		}
	}
}
