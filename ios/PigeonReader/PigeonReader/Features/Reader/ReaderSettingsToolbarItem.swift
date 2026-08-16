import SwiftUI

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
