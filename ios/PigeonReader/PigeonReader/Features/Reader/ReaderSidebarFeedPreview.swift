import SwiftUI

/// The native context-menu preview for a feed row. It only reads the model's
/// already-loaded cache while the preview is being built; it never starts a
/// load, changes selection, or mutates read state.
struct ReaderSidebarFeedPreview: View {
	let feed: ReaderNavigationItem
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
		let cachedArticles = model.hasCachedCollection(feed) ? model.allArticles(for: feed) : nil
		let preview = ReaderSidebarFeedPreviewData.make(feed: feed, cachedArticles: cachedArticles)

		VStack(alignment: .leading, spacing: 12) {
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				Text(preview.title)
					.font(.headline)
					.lineLimit(2)
				Spacer(minLength: 8)
				Text("\(preview.unreadCount) unread")
					.font(.subheadline.monospacedDigit())
					.foregroundStyle(.secondary)
			}

			switch preview.cacheState {
			case .uncached:
				Label("Stories aren't cached yet", systemImage: "clock")
					.foregroundStyle(.secondary)
			case .empty:
				Label("No cached stories", systemImage: "tray")
					.foregroundStyle(.secondary)
			case .loaded(let headlines):
				VStack(alignment: .leading, spacing: 8) {
					ForEach(headlines) { headline in
						Text(headline.title)
							.font(.subheadline)
							.lineLimit(2)
					}
				}
			}
		}
		.padding()
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .contain)
		.accessibilityLabel(preview.title)
		.accessibilityValue("\(preview.unreadCount) unread")
	}
}
