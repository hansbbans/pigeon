import SwiftUI
import UIKit

/// The newspaper-style alternative to the Classic story list. It reuses the
/// list's data, selection, and actions; only the presentation differs.
struct FrontPageView<StoryMenu: View, Footer: View>: View {
	let title: String
	let unreadCount: Int
	let articles: [Recommendation]
	let selectedArticleID: String?
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let thumbnailScope: String?
	let select: (Recommendation) -> Void
	let onNearEndChange: (Bool) -> Void
	let onUserScroll: () -> Void
	let onScrollingChange: (Bool) -> Void
	/// A story became, or stopped being, at least half visible (reading log).
	let onStoryVisibilityChange: (String, Bool) -> Void
	@ViewBuilder let storyMenu: (Recommendation) -> StoryMenu
	@ViewBuilder let footer: () -> Footer

	@Environment(\.dynamicTypeSize) private var dynamicTypeSize
	/// Width of the scroll view; a narrow iPad column gets a one-column grid.
	@State private var availableWidth: Double?

	private let nearEndDistance = 900.0

	var body: some View {
		ScrollView {
			LazyVStack(alignment: .leading, spacing: 0) {
				FrontPageMasthead(title: title, unreadCount: unreadCount, usesSpread: usesSpread)
					.padding(.bottom, 18)
					.id(FrontPageLayout.topAnchorID)
				ForEach(Array(FrontPageLayout.pages(for: articles).enumerated()), id: \.element.id) { index, page in
					if index > 0 {
						FrontPageRule(thickness: 2)
							.padding(.vertical, 22)
					}
					story(page.lead, role: .lead)
					if page.grid.isEmpty == false {
						FrontPageRule(thickness: 0.5)
							.padding(.vertical, 18)
						LazyVGrid(columns: gridColumns, alignment: .leading, spacing: 22) {
							ForEach(page.grid) { article in
								story(article, role: .column)
							}
						}
					}
				}
				VStack(spacing: 12) {
					footer()
				}
				.frame(maxWidth: .infinity)
				.padding(.top, 28)
			}
			.padding(.horizontal, horizontalPadding)
			.padding(.bottom, 24)
			.frame(maxWidth: FrontPageLayout.maximumContentWidth(usesSpread: usesSpread))
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
	}

	private var usesSpread: Bool {
		FrontPageLayout.usesSpread(
			availableWidth: availableWidth,
			usesAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
		)
	}

	private var horizontalPadding: Double {
		usesSpread ? 28 : 16
	}

	/// In a spread the lead image takes a little over half the page, beside
	/// its headline and deck.
	private var spreadImageWidth: Double? {
		guard usesSpread, let availableWidth else { return nil }
		let pageWidth = min(availableWidth, FrontPageLayout.maximumContentWidth(usesSpread: true))
		return ((pageWidth - horizontalPadding * 2 - FrontPageStoryView.spreadSpacing) * 0.58).rounded(.down)
	}

	private var gridColumns: [GridItem] {
		let column = GridItem(.flexible(), spacing: usesSpread ? 28 : 18, alignment: .top)
		let count = FrontPageLayout.gridColumnCount(
			availableWidth: availableWidth,
			usesAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
		)
		return Array(repeating: column, count: count)
	}

	private func story(_ article: Recommendation, role: FrontPageStoryView.Role) -> some View {
		FrontPageStoryView(
			article: article,
			role: role,
			spreadImageWidth: role == .lead ? spreadImageWidth : nil,
			isSelected: selectedArticleID == article.id,
			remoteImagePolicy: remoteImagePolicy,
			thumbnailScope: thumbnailScope,
			select: { select(article) },
		)
		.contextMenu { storyMenu(article) }
		.onScrollVisibilityChange(threshold: 0.5) { isVisible in
			onStoryVisibilityChange(article.id, isVisible)
		}
		// A row can leave the hierarchy (a reload, a jump to the top) without
		// being told it is no longer visible.
		.onDisappear { onStoryVisibilityChange(article.id, false) }
	}
}

private struct FrontPageMasthead: View {
	@Environment(\.readerTypeface) private var readerTypeface
	let title: String
	let unreadCount: Int
	let usesSpread: Bool

	var body: some View {
		VStack(spacing: 8) {
			FrontPageRule(thickness: 2)
			Text(title)
				.font(ReaderTypography.italic(readerTypeface, size: usesSpread ? 52 : 38, relativeTo: .largeTitle))
				.multilineTextAlignment(.center)
				.lineLimit(2)
				.minimumScaleFactor(0.7)
				.frame(maxWidth: .infinity)
				.accessibilityAddTraits(.isHeader)
			FrontPageRule(thickness: 0.5)
			// Large text sizes stack the dateline instead of breaking words mid-line.
			ViewThatFits(in: .horizontal) {
				HStack {
					dateText.fixedSize()
					Spacer()
					unreadText.fixedSize()
				}
				VStack(alignment: .leading, spacing: 4) {
					dateText
					unreadText
				}
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.font(.caption2.weight(.semibold))
			.textCase(.uppercase)
			.tracking(0.8)
			.foregroundStyle(.pigeonSecondary)
			.accessibilityElement(children: .combine)
			FrontPageRule(thickness: 2)
		}
		.padding(.top, 4)
	}

	private var dateText: some View {
		Text(Date.now, format: .dateTime.weekday(.wide).month(.wide).day())
	}

	private var unreadText: some View {
		Text(unreadCount == 0 ? "All read" : "\(unreadCount.formatted()) unread")
	}
}

private struct FrontPageRule: View {
	let thickness: Double

	var body: some View {
		Rectangle()
			.fill(.primary.opacity(thickness > 1 ? 0.85 : 0.25))
			.frame(height: thickness)
			.accessibilityHidden(true)
	}
}

struct FrontPageStoryView: View {
	enum Role {
		case lead
		case column

		var imageTarget: ReaderFeedThumbnailPixelSize {
			switch self {
			case .lead: ReaderFeedThumbnailPixelSize(width: 960, height: 640)
			case .column: ReaderFeedThumbnailPolicy.rowPixelSize
			}
		}

		var minimumImageWidth: Int {
			switch self {
			case .lead: 320
			case .column: 140
			}
		}
	}

	static let spreadSpacing = 24.0

	let article: Recommendation
	let role: Role
	/// Set for the lead of a wide page: the image is this wide and sits
	/// beside the headline instead of above it.
	var spreadImageWidth: Double?
	let isSelected: Bool
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let thumbnailScope: String?
	let select: () -> Void

	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.showsReadingTime) private var showsReadingTime
	@Environment(\.displayScale) private var displayScale
	@Environment(\.readerTypeface) private var readerTypeface
	@Environment(\.verticalSizeClass) private var verticalSizeClass
	@State private var image: CGImage?
	@State private var imageRequestID: String?

	var body: some View {
		Button(action: select) {
			Group {
				if let spreadImageWidth, let image = loadedImage {
					HStack(alignment: .top, spacing: Self.spreadSpacing) {
						imageView(image)
							.frame(width: spreadImageWidth)
						storyText
					}
				} else {
					VStack(alignment: .leading, spacing: textSpacing) {
						if let image = loadedImage {
							imageView(image)
						}
						storyText
					}
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(6)
			.background {
				RoundedRectangle(cornerRadius: 8)
					.fill(Color.accentColor.opacity(isSelected ? 0.1 : 0))
			}
			.padding(-6)
		}
		.buttonStyle(ReaderRowButtonStyle())
		.opacity(article.isRead ? 0.5 : 1)
		.animation(ReaderMotion.animation(reduceMotion: reduceMotion), value: article.isRead)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("\(article.source), \(article.title)")
		.accessibilityValue(accessibilityValue)
		.accessibilityAddTraits(.isButton)
		.accessibilityAction { select() }
		.accessibilityIdentifier("front-page-story-\(article.id)")
		.task(id: requestID) {
			await loadImage()
		}
	}

	private var loadedImage: CGImage? {
		imageRequestID == requestID ? image : nil
	}

	private var textSpacing: Double {
		role == .lead ? 9 : 6
	}

	private var isSpreadLead: Bool {
		spreadImageWidth != nil
	}

	private func imageView(_ image: CGImage) -> some View {
		Color.clear
			.aspectRatio(imageAspectRatio, contentMode: .fit)
			.overlay {
				Image(decorative: image, scale: displayScale)
					.resizable()
					.scaledToFill()
			}
			.clipShape(.rect(cornerRadius: 12, style: .continuous))
			.accessibilityHidden(true)
	}

	private var storyText: some View {
		VStack(alignment: .leading, spacing: textSpacing) {
			Text(article.source)
				.font(.caption2.weight(.bold))
				.textCase(.uppercase)
				.tracking(0.9)
				.foregroundStyle(FrontPageKickerPalette.color(for: article.feedKey))
				.lineLimit(1)
			PaywallLabel.title(article.title, isPaywalled: article.isPaywalled)
				.font(role == .lead
					? ReaderTypography.title(readerTypeface, size: isSpreadLead ? 34 : 27, relativeTo: .title)
					: ReaderTypography.storyTitle(readerTypeface))
				.foregroundStyle(.primary)
				.lineLimit(role == .lead ? 5 : 4)
				.fixedSize(horizontal: false, vertical: true)
			if role == .lead, let deck = FrontPageLayout.deck(from: article.text) {
				Text(deck)
					.font(ReaderTypography.body(readerTypeface, size: isSpreadLead ? 18 : 16, relativeTo: .callout))
					.foregroundStyle(.pigeonSecondary)
					.lineLimit(isSpreadLead ? 6 : 3)
			}
			HStack(spacing: 6) {
				Text(article.receivedAt, format: .relative(presentation: .named))
				if let readingLength = article.readingLengthLabel(showsReadingTime: showsReadingTime) {
					Text("· \(readingLength)")
				}
				if article.isStarred {
					Image(systemName: "star.fill")
						.foregroundStyle(.pigeonKeep)
				}
			}
			.font(.caption2)
			.foregroundStyle(.pigeonSecondary)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	/// A 3:2 lead image at full width is taller than an iPhone in landscape, so
	/// a short window crops the lead to a banner and keeps the headline on
	/// screen. A spread's image is only half the page wide, so it keeps 3:2.
	private var imageAspectRatio: CGFloat {
		switch role {
		case .lead: verticalSizeClass == .compact && isSpreadLead == false ? 21 / 9 : 3 / 2
		case .column: 4 / 3
		}
	}

	private var accessibilityValue: String {
		var parts = [article.isRead ? "Read" : "Unread"]
		if article.isStarred { parts.append("Starred") }
		if article.isPaywalled == true { parts.append(PaywallLabel.accessibilityValue) }
		if let readingLength = article.readingLengthLabel(showsReadingTime: showsReadingTime) { parts.append(readingLength) }
		return parts.joined(separator: ", ")
	}

	/// Images follow the shared thumbnail pipeline, which only loads publisher
	/// images under the Load Normally policy. Other policies stay text-only.
	private var requestID: String {
		"\(article.id)|\(thumbnailScope ?? "none")|\(remoteImagePolicy.rawValue)|\(role)"
	}

	private func loadImage() async {
		let request = requestID
		guard remoteImagePolicy == .normal, let thumbnailScope, thumbnailScope.isEmpty == false else {
			image = nil
			imageRequestID = nil
			return
		}
		let loaded = await ReaderFeedThumbnailStore.shared.thumbnail(
			for: article,
			scope: thumbnailScope,
			target: role.imageTarget,
		)
		guard Task.isCancelled == false, request == requestID else { return }
		if let loaded, FrontPageLayout.isEditorialImage(
			width: loaded.width,
			height: loaded.height,
			minimumWidth: role.minimumImageWidth,
		) {
			image = loaded
			imageRequestID = request
		} else {
			image = nil
			imageRequestID = nil
		}
	}
}

extension FrontPageKickerPalette {
	private static let colors: [Color] = [
		dynamic(light: 0xB3261E, dark: 0xFF8A80),
		dynamic(light: 0x1F6F6A, dark: 0x6FD6CC),
		dynamic(light: 0x3A5BA0, dark: 0x9DB6FF),
		dynamic(light: 0x8A5A00, dark: 0xF2C14E),
		dynamic(light: 0x6A57C9, dark: 0xBCAEFF),
		dynamic(light: 0x2E7D32, dark: 0x8BD48F),
		dynamic(light: 0xA2386B, dark: 0xF59AC4),
		dynamic(light: 0x5D4037, dark: 0xD7B8A8),
	]

	static func color(for feedKey: String) -> Color {
		colors[colorIndex(for: feedKey) % colors.count]
	}

	static func color(at index: Int) -> Color {
		colors[((index % colors.count) + colors.count) % colors.count]
	}

	/// UIKit may resolve dynamic colours off the main thread.
	nonisolated private static func dynamic(light: UInt32, dark: UInt32) -> Color {
		Color(uiColor: UIColor { traits in
			let hex = traits.userInterfaceStyle == .dark ? dark : light
			return UIColor(
				red: CGFloat((hex >> 16) & 0xFF) / 255,
				green: CGFloat((hex >> 8) & 0xFF) / 255,
				blue: CGFloat(hex & 0xFF) / 255,
				alpha: 1,
			)
		})
	}
}
