import SwiftUI

/// One tap between the two looks, in the top bar of Home, the library and every
/// list. Its symbol is the look it switches to: a list for Reeder from Cards,
/// a grid for Cards from Reeder.
struct ReaderLookToggleButton: View {
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
		let other = model.readerTypography.look.toggled
		Button("Switch to \(other.title)", systemImage: other.toggleSystemImage) {
			model.readerTypography.look = other
		}
		.accessibilityIdentifier(ReaderLookToggleButton.accessibilityIdentifier)
		.accessibilityValue(model.readerTypography.look.title)
		.accessibilityHint("Switches between the Cards and Reeder looks")
	}

	static let accessibilityIdentifier = "toggle-look"
}

struct ReaderLookToolbarItem: ToolbarContent {
	var body: some ToolbarContent {
		ToolbarItem(placement: .topBarTrailing) {
			ReaderLookToggleButton()
		}
	}
}

extension ReaderLook {
	/// The other look.
	nonisolated var toggled: Self {
		switch self {
		case .cards: .reeder
		case .reeder: .cards
		}
	}

	/// The symbol for switching to this look.
	nonisolated var toggleSystemImage: String {
		switch self {
		case .cards: "square.grid.2x2"
		case .reeder: "list.bullet"
		}
	}
}
