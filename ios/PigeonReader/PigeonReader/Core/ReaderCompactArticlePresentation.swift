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

	static func splitViewColumn(
		horizontalSizeClass: UserInterfaceSizeClass?,
		preferredColumn: NavigationSplitViewColumn,
	) -> NavigationSplitViewColumn {
		horizontalSizeClass != .regular && preferredColumn == .detail ? .content : preferredColumn
	}
}
