import SwiftUI

/// The quiet label above one feed's stories when a folder is shown By Feed.
/// It is a heading, not a story: it takes no selection, actions, or count.
struct ArticleFeedSectionLabel: View {
	let feed: ArticleFeedDirectory.Feed
	let remoteImagePolicy: ReaderRemoteImagePolicy

	@ScaledMetric(relativeTo: .footnote) private var iconSize = 16.0

	var body: some View {
		HStack(spacing: 8) {
			// The favicon is publisher-hosted, so it follows the list's image policy.
			if remoteImagePolicy == .normal, let iconURL = feed.iconURL {
				FeedIconImage(url: iconURL) { image in
					if let image {
						image
							.resizable()
							.scaledToFit()
							.clipShape(.rect(cornerRadius: 3))
					} else {
						Color.clear
					}
				}
				.frame(width: iconSize, height: iconSize)
				.accessibilityHidden(true)
			}
			Text(feed.title)
				.font(.footnote.weight(.semibold))
				.textCase(.uppercase)
				.tracking(0.8)
				.foregroundStyle(.pigeonSecondary)
				.lineLimit(1)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
		.accessibilityIdentifier("article-feed-section-\(feed.id)")
	}
}
