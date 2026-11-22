import SwiftUI

nonisolated enum FolderCardsLayout {
	static let topAnchorID = "folder-cards-top"
	/// Feed cards carry several headlines each, so they stop at three across,
	/// where Home's single-headline tiles go to four.
	static let maximumFeedColumns = 3

	/// One column of cards on a phone and at accessibility sizes; a wide
	/// window lays feed cards out like Home's folder tiles.
	static func feedColumnCount(usesAccessibilitySize: Bool, availableWidth: Double?) -> Int {
		guard usesAccessibilitySize == false,
			let availableWidth, availableWidth >= ReaderHomeTiles.wideLayoutMinimumWidth else { return 1 }
		return min(
			ReaderHomeTiles.folderColumnCount(usesAccessibilitySize: false, availableWidth: availableWidth),
			maximumFeedColumns,
		)
	}

	/// Cards in rows of `columns`, left to right; the last row may be short.
	static func rows<Item>(of items: [Item], columns: Int) -> [[Item]] {
		let columns = max(columns, 1)
		return stride(from: 0, to: items.count, by: columns).map { start in
			Array(items[start..<min(start + columns, items.count)])
		}
	}
}

/// The Cards page's sections, built once per change of what they show.
/// SwiftUI evaluates the list's body on every model change (a scroll, a
/// count, a read elsewhere); rebuilding a big folder's cards each time is
/// wasted work. Not observable: reading it never invalidates a view.
final class FolderCardsSectionsCache {
	/// Everything the sections depend on. `articles` is the list as shown, so
	/// it carries the filter and every story's read and starred state; `day`
	/// is the local day, so the page moves on at midnight.
	struct Key: Equatable {
		let articles: [Recommendation]
		let expanded: Set<String>
		let feeds: ArticleFeedDirectory
		let isFolder: Bool
		let day: Date
	}

	private var key: Key?
	private var cached: FolderSections?

	func sections(for key: Key, make: () -> FolderSections) -> FolderSections {
		if let cached, self.key == key { return cached }
		let sections = make()
		self.key = key
		cached = sections
		return sections
	}
}

/// A folder or a feed in the Cards look: a column of cards in the Home tile
/// style, each with the folder's colour bar. It reuses the list's data,
/// selection and actions, like `FrontPageView`.
struct FolderCardsView<StoryMenu: View, Footer: View>: View {
	let sections: FolderSections
	let feeds: ArticleFeedDirectory
	/// Today and Last 7 Days mix feeds, so their stories name their feed. A
	/// single feed's day cards do not.
	let showsFeedNames: Bool
	let colorIndex: Int?
	let selectedArticleID: String?
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let select: (Recommendation) -> Void
	let onExpand: (String) -> Void
	/// Whether a feed card's header opens that feed; a story from a feed the
	/// library does not list has nowhere to go.
	let canOpenFeed: (ArticleFeedDirectory.Feed) -> Bool
	let onOpenFeed: (ArticleFeedDirectory.Feed) -> Void
	let onNearEndChange: (Bool) -> Void
	let onUserScroll: () -> Void
	let onScrollingChange: (Bool) -> Void
	/// One drawn copy (story id, copy key) of a story became, or stopped
	/// being, at least half visible (reading log).
	let onStoryVisibilityChange: (String, Bool, String) -> Void
	/// A story's menu, with the story's place in `sections.renderedCopies`
	/// (a story shown twice has two).
	@ViewBuilder let storyMenu: (Recommendation, Int?) -> StoryMenu
	@ViewBuilder let footer: () -> Footer

	@Environment(\.dynamicTypeSize) private var dynamicTypeSize
	@State private var availableWidth: Double?

	private let nearEndDistance = 900.0

	var body: some View {
		ScrollView {
			// Eager on purpose. Every card is capped, so the page stays small, and
			// a lazy stack of cards this uneven re-estimated the page's height on
			// every pass: the near-end flag flipped with it and the app hung.
			VStack(alignment: .leading, spacing: 10) {
				Color.clear
					.frame(height: 0)
					.id(FolderCardsLayout.topAnchorID)
				ForEach(blocks) { block in
					switch block.content {
					case let .card(section):
						card(section)
					case .olderHeader:
						Text("Older")
							.font(.footnote.weight(.semibold))
							.foregroundStyle(.pigeonSecondary)
							.padding(.top, 14)
							.accessibilityAddTraits(.isHeader)
							.accessibilityIdentifier("folder-cards-older")
					case let .feedGrid(feedSections):
						feedGrid(feedSections)
					}
				}
				VStack(spacing: 12) {
					footer()
				}
				.frame(maxWidth: .infinity)
				.padding(.top, 18)
			}
			.padding(.horizontal, 16)
			.padding(.top, 8)
			.padding(.bottom, 24)
			.frame(maxWidth: ReaderHomeTiles.maximumContentWidth)
			.frame(maxWidth: .infinity)
		}
		.onGeometryChange(for: Double.self) { geometry in
			Double(geometry.size.width)
		} action: { _, width in
			availableWidth = width
		}
		.onScrollGeometryChange(for: Bool.self) { geometry in
			geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - nearEndDistance
		} action: { _, isNearEnd in
			onNearEndChange(isNearEnd)
		}
		.onScrollPhaseChange { _, phase in
			onScrollingChange(phase != .idle)
			if phase == .interacting { onUserScroll() }
		}
		.scrollEdgeEffectStyle(.soft, for: .top)
		.background(Color(.systemGroupedBackground))
	}

	private var barColor: Color? {
		colorIndex.map(FrontPageKickerPalette.color(at:))
	}

	private var feedColumnCount: Int {
		FolderCardsLayout.feedColumnCount(
			usesAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
			availableWidth: availableWidth,
		)
	}

	/// Equal columns, each card as tall as its own stories, like Home's tiles.
	private func feedGrid(_ sections: [FolderSections.Section]) -> some View {
		let columns = feedColumnCount
		return VStack(alignment: .leading, spacing: 10) {
			ForEach(FolderCardsLayout.rows(of: sections, columns: columns), id: \.first?.id) { row in
				HStack(alignment: .top, spacing: 10) {
					ForEach(row) { section in
						card(section)
					}
					ForEach(row.count..<columns, id: \.self) { _ in
						Color.clear
							.frame(maxWidth: .infinity, maxHeight: 0)
							.accessibilityHidden(true)
					}
				}
			}
		}
	}

	/// Today, Last 7 Days and day cards span the width; runs of feed cards
	/// share a grid, split by the Older header.
	private var blocks: [Block] {
		var blocks: [Block] = []
		var run: [FolderSections.Section] = []
		func closeRun() {
			guard let first = run.first else { return }
			blocks.append(Block(id: "grid:\(first.id)", content: .feedGrid(run)))
			run = []
		}
		for section in sections.sections {
			switch section.kind {
			case .feed:
				run.append(section)
			case .older:
				closeRun()
				blocks.append(Block(id: section.id, content: .olderHeader))
			case .today, .lastSevenDays, .yesterday, .earlier:
				closeRun()
				blocks.append(Block(id: section.id, content: .card(section)))
			}
		}
		closeRun()
		return blocks
	}

	private func card(_ section: FolderSections.Section) -> some View {
		VStack(alignment: .leading, spacing: 12) {
			header(section)
			ForEach(Array(section.articles.enumerated()), id: \.element.id) { index, article in
				story(article, in: section, copyIndex: sections.copyIndex(of: index, inSection: section.id))
			}
			if section.hiddenCount > 0 {
				Button {
					onExpand(section.id)
				} label: {
					Text("\(section.hiddenCount) more")
						.font(.footnote.weight(.semibold))
						.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
						.contentShape(.rect)
				}
				.buttonStyle(.plain)
				.foregroundStyle(.tint)
				.padding(.top, -10)
				.accessibilityHint("Shows every loaded story in \(section.title)")
				.accessibilityIdentifier("folder-card-more-\(section.id)")
			}
		}
		.padding(.horizontal, 12)
		.padding(.top, 10)
		.padding(.bottom, section.hiddenCount > 0 ? 0 : 14)
		.frame(maxWidth: .infinity, alignment: .topLeading)
		.readerTileBackground(barColor: barColor)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("folder-card-\(section.id)")
	}

	@ViewBuilder
	private func header(_ section: FolderSections.Section) -> some View {
		if let feed = section.feed, canOpenFeed(feed) {
			Button {
				onOpenFeed(feed)
			} label: {
				FolderCardHeader(title: section.title, color: barColor, iconURL: iconURL(for: feed))
					.contentShape(.rect.inset(by: -6))
			}
			.buttonStyle(ReaderRowButtonStyle())
			.accessibilityLabel(section.title)
			.accessibilityHint("Opens \(section.title)")
			.accessibilityIdentifier("folder-card-open-\(section.id)")
		} else {
			FolderCardHeader(title: section.title, color: barColor, iconURL: section.feed.flatMap(iconURL(for:)))
				.accessibilityElement(children: .combine)
				.accessibilityAddTraits(.isHeader)
		}
	}

	/// Favicons are publisher-hosted, so they follow the image policy.
	private func iconURL(for feed: ArticleFeedDirectory.Feed) -> URL? {
		remoteImagePolicy == .normal ? feed.iconURL : nil
	}

	private func story(_ article: Recommendation, in section: FolderSections.Section, copyIndex: Int?) -> some View {
		let showsFeed = showsFeedNames && (section.kind == .today || section.kind == .lastSevenDays)
		return FolderCardStoryView(
			article: article,
			feed: showsFeed ? feeds.feed(for: article) : nil,
			isSelected: selectedArticleID == article.id,
			select: { select(article) },
		)
		.contextMenu { storyMenu(article, copyIndex) }
		.modifier(StoryCopyVisibility(articleID: article.id, cardID: section.id, onChange: onStoryVisibilityChange))
	}

	private struct Block: Identifiable {
		enum Content {
			case card(FolderSections.Section)
			case olderHeader
			case feedGrid([FolderSections.Section])
		}

		let id: String
		let content: Content
	}
}

/// Reports one drawn copy of a story crossing half visibility. Each copy
/// reports under a key of its own view's lifetime, not just its card's id:
/// when a card is rebuilt, the old copy's late `onDisappear` must not hide
/// the copy that replaced it.
private struct StoryCopyVisibility: ViewModifier {
	let articleID: String
	let cardID: String
	let onChange: (String, Bool, String) -> Void
	@State private var instance = UUID()

	func body(content: Content) -> some View {
		let copy = "\(cardID)#\(instance.uuidString)"
		content
			.onScrollVisibilityChange(threshold: 0.5) { isVisible in
				onChange(articleID, isVisible, copy)
			}
			// A card can leave the hierarchy (a reload, an expansion) without
			// being told its stories are no longer visible.
			.onDisappear { onChange(articleID, false, copy) }
	}
}

/// A card's name in kicker type and the folder's colour, after the feed's
/// favicon on a feed card.
private struct FolderCardHeader: View {
	let title: String
	let color: Color?
	let iconURL: URL?

	var body: some View {
		HStack(spacing: 8) {
			if let iconURL {
				ReaderHomeFeedIcon(url: iconURL)
					.accessibilityHidden(true)
			}
			// A step above the stories' feed kickers, so the card's name leads.
			Text(title)
				.font(.footnote.weight(.bold))
				.textCase(.uppercase)
				.tracking(0.8)
				.foregroundStyle(color ?? .pigeonSecondary)
				.lineLimit(1)
			Spacer(minLength: 0)
		}
		.frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
	}
}

/// A story on a card: optional feed kicker, the headline in the reading
/// typeface and one caption line. Read stories change weight and colour.
struct FolderCardStoryView: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.showsReadingTime) private var showsReadingTime
	@Environment(\.readerTypeface) private var readerTypeface
	let article: Recommendation
	/// Set on cards that mix feeds.
	let feed: ArticleFeedDirectory.Feed?
	let isSelected: Bool
	let select: () -> Void

	var body: some View {
		Button(action: select) {
			VStack(alignment: .leading, spacing: 4) {
				if let feed {
					Text(feed.title)
						.font(.caption2.weight(.bold))
						.textCase(.uppercase)
						.tracking(0.8)
						.foregroundStyle(FrontPageKickerPalette.color(for: feed.id))
						.lineLimit(1)
				}
				PaywallLabel.title(article.title, isPaywalled: article.isPaywalled)
					.font(article.isRead
						? ReaderTypography.body(readerTypeface, size: 17, relativeTo: .body)
						: ReaderTypography.storyTitle(readerTypeface))
					.foregroundStyle(article.isRead ? Color.pigeonSecondary : Color.primary)
					.lineLimit(3)
					.multilineTextAlignment(.leading)
					.fixedSize(horizontal: false, vertical: true)
				HStack(spacing: 6) {
					Text(article.receivedAt, format: .relative(presentation: .named))
					if let readingLength {
						Text("· \(readingLength)")
					}
					if article.isStarred {
						Image(systemName: "star.fill")
							.foregroundStyle(.pigeonKeep)
					}
				}
				.font(.caption)
				.foregroundStyle(.pigeonSecondary)
				.lineLimit(1)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(6)
			.background {
				RoundedRectangle(cornerRadius: 8, style: .continuous)
					.fill(Color.accentColor.opacity(isSelected ? 0.1 : 0))
			}
			.padding(-6)
		}
		.buttonStyle(ReaderRowButtonStyle())
		.animation(ReaderMotion.animation(reduceMotion: reduceMotion), value: article.isRead)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(feed.map { "\($0.title), \(article.title)" } ?? article.title)
		.accessibilityValue(accessibilityValue)
		.accessibilityAddTraits(.isButton)
		.accessibilityAction { select() }
		.accessibilityIdentifier("folder-card-story-\(article.id)")
	}

	private var readingLength: String? {
		article.readingLengthLabel(showsReadingTime: showsReadingTime)
	}

	private var accessibilityValue: String {
		var parts = [article.isRead ? "Read" : "Unread"]
		if article.isStarred { parts.append("Starred") }
		if article.isPaywalled == true { parts.append(PaywallLabel.accessibilityValue) }
		if let readingLength { parts.append(readingLength) }
		return parts.joined(separator: ", ")
	}
}
