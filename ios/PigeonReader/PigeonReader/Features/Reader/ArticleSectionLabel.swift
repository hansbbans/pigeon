import SwiftUI

/// The small grey uppercase label over one section of a Reeder list (Today,
/// Last 7 Days, a feed, Older, a day). It is a heading, not a story: it takes
/// no selection or swipe actions. A feed's label opens that feed.
struct ArticleSectionLabel: View {
	let section: FolderSections.Section
	let remoteImagePolicy: ReaderRemoteImagePolicy
	/// Set when the label is a feed's and the feed can be opened on its own.
	let openFeed: (() -> Void)?

	@ScaledMetric(relativeTo: .caption) private var iconSize = 14.0

	var body: some View {
		if let openFeed, let feed = section.feed {
			Button(action: openFeed) {
				content
			}
			.buttonStyle(.plain)
			.accessibilityHint("Opens \(feed.title)")
			.accessibilityIdentifier(identifier)
		} else {
			content
				.accessibilityIdentifier(identifier)
		}
	}

	private var content: some View {
		HStack(spacing: 6) {
			// The favicon is publisher-hosted, so it follows the list's image policy.
			if remoteImagePolicy == .normal, let iconURL = section.feed?.iconURL {
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
			Text(section.title)
				.font(ReaderTypography.sectionLabel)
				.textCase(.uppercase)
				.tracking(ReaderTypography.sectionLabelTracking)
				.foregroundStyle(.pigeonSecondary)
				.lineLimit(1)
			Spacer(minLength: 8)
			if openFeed != nil {
				Image(systemName: "chevron.right")
					.font(.caption.weight(.semibold))
					.foregroundStyle(.pigeonSecondary)
					.accessibilityHidden(true)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}

	private var identifier: String {
		if let feed = section.feed { "article-feed-section-\(feed.id)" } else { "article-section-\(section.id)" }
	}
}

/// "N more" under a collapsed section: shows the rest of its loaded stories.
struct ArticleSectionMoreButton: View {
	let section: FolderSections.Section
	let expand: () -> Void

	var body: some View {
		Button(action: expand) {
			Text("\(section.hiddenCount.formatted()) more")
				.font(ReaderTypography.listMeta)
				.foregroundStyle(.tint)
				.frame(maxWidth: .infinity, alignment: .leading)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("Show \(section.hiddenCount) more in \(section.title)")
		.accessibilityIdentifier("article-section-more-\(section.id)")
	}
}
