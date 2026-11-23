import SwiftUI

/// Compact (iPhone) article presentation that keeps the library list mounted.
///
/// `NavigationSplitView` on a compact size class shows only `preferredCompactColumn`.
/// The shell also used to replace that split view with a standalone article stack,
/// which destroyed `ArticleListView` and cleared search, scroll, and filter UI.
/// Keep the split view on the feed column and own the article in an overlay.
nonisolated enum ReaderCompactArticlePresentation {
	static func isActive(
		horizontalSizeClass: UserInterfaceSizeClass?,
		preferredColumn: NavigationSplitViewColumn,
		hasSelectedArticle: Bool,
	) -> Bool {
		horizontalSizeClass != .regular && preferredColumn == .detail && hasSelectedArticle
	}

	/// The size class the library navigates with. Cards are pages, not a
	/// column: a regular window in Cards navigates the way a phone does
	/// (Home, then the page, then the article, each across the whole window)
	/// instead of squeezing a page between the sidebar and an empty reader.
	static func navigationSizeClass(
		window: UserInterfaceSizeClass?,
		look: ReaderLook,
	) -> UserInterfaceSizeClass? {
		window == .regular && look == .cards ? .compact : window
	}

	/// Switching a regular window to Cards collapses it, so a story open
	/// beside the list would suddenly cover the window. The switch is made from
	/// the list or Settings, so show the page that was asked for.
	static func columnAfterLookChange(
		window: UserInterfaceSizeClass?,
		look: ReaderLook,
		preferredColumn: NavigationSplitViewColumn,
	) -> NavigationSplitViewColumn {
		window == .regular && look == .cards && preferredColumn == .detail ? .content : preferredColumn
	}

	/// In a regular window the split view shows the library beside the list,
	/// so `.sidebar` (where a launch, an account change or a compact window
	/// leaves the column) has nothing of its own to show: open the list. A
	/// Cards window navigates as compact and keeps its Home.
	static func columnWithoutHome(
		horizontalSizeClass: UserInterfaceSizeClass?,
		preferredColumn: NavigationSplitViewColumn,
	) -> NavigationSplitViewColumn {
		horizontalSizeClass == .regular && preferredColumn == .sidebar ? .content : preferredColumn
	}

	static func splitViewColumn(
		horizontalSizeClass: UserInterfaceSizeClass?,
		preferredColumn: NavigationSplitViewColumn,
	) -> NavigationSplitViewColumn {
		horizontalSizeClass != .regular && preferredColumn == .detail ? .content : preferredColumn
	}
}
