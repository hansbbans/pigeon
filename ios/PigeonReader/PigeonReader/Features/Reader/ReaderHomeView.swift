import SwiftUI

/// Home for the split view's first column. On iPhone it is the tile grid, with
/// the full library list one tap away; wider layouts always use the list.
struct ReaderHomeView: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	/// The sidebar column reports a compact size class even on iPad, so the
	/// shell decides from the window's size class.
	let allowsTiles: Bool
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
