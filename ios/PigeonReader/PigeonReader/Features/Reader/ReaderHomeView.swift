import SwiftUI

/// Home is the tile grid, with the full library list one tap away. A compact
/// window shows it as the split view's first column; a regular window shows it
/// over the split view until a view is chosen, and that split view's own
/// sidebar is always the list.
struct ReaderHomeView: View {
	/// The sidebar column reports a compact size class even on iPad, so the
	/// shell decides from the window's size class.
	enum Placement {
		/// The first column of a compact window.
		case compactRoot
		/// The sidebar column of a regular window, beside the open list.
		case splitSidebar
		/// Home covering a regular window.
		case regularHome
	}

	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	let placement: Placement
	@State private var showsLibraryList = ReaderHomeView.startsOnLibraryList

	var body: some View {
		if allowsTiles, showsLibraryList == false {
			ReaderHomeTilesView(onShowLibrary: { setShowsLibraryList(true) })
				.transition(.opacity)
		} else {
			ReaderSidebarView(onShowHome: allowsTiles ? { setShowsLibraryList(false) } : nil)
				.transition(.opacity)
		}
	}

	private var allowsTiles: Bool {
		placement != .splitSidebar
	}

	private func setShowsLibraryList(_ shows: Bool) {
		withAnimation(ReaderMotion.feedSwitch(reduceMotion: reduceMotion)) {
			showsLibraryList = shows
		}
	}

	/// UI tests written against the library list start on it.
	private static var startsOnLibraryList: Bool {
		#if DEBUG
		ProcessInfo.processInfo.environment["PIGEON_UI_TEST_HOME"] == "list"
		#else
		false
		#endif
	}
}
