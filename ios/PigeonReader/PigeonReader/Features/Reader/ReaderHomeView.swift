import SwiftUI

/// The library's root. Cards: Home is the tile grid, with All Feeds (more
/// tiles) one tap away. Reeder has no Home: the root is the library list, the
/// first column of the split view on iPhone and iPad alike.
struct ReaderHomeView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var showsLibraryList = ReaderHomeView.startsOnLibraryList

	var body: some View {
		if usesTiles, showsLibraryList == false {
			ReaderHomeTilesView(onShowLibrary: { setShowsLibraryList(true) })
				.transition(.opacity)
		} else if usesTiles, Self.startsOnLibraryList == false {
			ReaderLibraryTilesView(onShowHome: { setShowsLibraryList(false) })
				.transition(.opacity)
		} else {
			// UI tests written against the library list reach it in Cards too,
			// with the way back to the tiles.
			ReaderSidebarView(onShowHome: usesTiles ? { setShowsLibraryList(false) } : nil)
				.transition(.opacity)
		}
	}

	private var usesTiles: Bool {
		model.readerTypography.look == .cards
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
