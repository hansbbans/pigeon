import SwiftUI

struct ArticleReaderHeaderView: View {
	let article: Recommendation
	let selectedMode: ReaderMode
	let hasOriginalURL: Bool
	let textScale: Double
	let canUseReaderView: Bool
	let onSelectMode: (ReaderMode) -> Void
	let onOpenOriginal: () -> Void

	init(
		article: Recommendation,
		selectedMode: ReaderMode,
		hasOriginalURL: Bool,
		textScale: Double,
		canUseReaderView: Bool = true,
		onSelectMode: @escaping (ReaderMode) -> Void,
		onOpenOriginal: @escaping () -> Void,
	) {
		self.article = article
		self.selectedMode = selectedMode
		self.hasOriginalURL = hasOriginalURL
		self.textScale = textScale
		self.canUseReaderView = canUseReaderView
		self.onSelectMode = onSelectMode
		self.onOpenOriginal = onOpenOriginal
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			HStack(alignment: .firstTextBaseline) {
				Text(article.source)
					.font(.subheadline.weight(.semibold))
					.foregroundStyle(.tint)
				Spacer(minLength: 12)
				Text(article.receivedAt, format: .dateTime.month(.wide).day().year())
					.font(.subheadline)
					.foregroundStyle(.secondary)
			}

			if let author = article.displayAuthor {
				Text(author)
					.font(.subheadline)
					.foregroundStyle(.secondary)
					.textSelection(.enabled)
			}

			PaywallLabel.title(article.title, isPaywalled: article.isPaywalled)
				.font(ReaderTypography.articleTitle(textScale: textScale))
				.bold()
				.fixedSize(horizontal: false, vertical: true)
				.frame(maxWidth: .infinity, alignment: .leading)
				.textSelection(.enabled)
				// Selectable text ignores label overrides and would read the paywall
				// flag as part of the title, so expose the title as its own element.
				.accessibilityElement(children: .ignore)
				.accessibilityLabel(article.title)
				.accessibilityValue(article.isPaywalled == true ? PaywallLabel.accessibilityValue : "")
				.accessibilityAddTraits([.isStaticText, .isHeader])

			HStack(spacing: 10) {
				Menu {
					ForEach(ReaderMode.allCases) { mode in
						Button {
							onSelectMode(mode)
						} label: {
							Label(mode.title, systemImage: mode.systemImage)
						}
						.disabled(
							mode != .feedContent
								&& (hasOriginalURL == false || (mode == .readerView && canUseReaderView == false)),
						)
					}
				} label: {
					Label(selectedMode.title, systemImage: selectedMode.systemImage)
				}
				.buttonStyle(.bordered)

				if hasOriginalURL {
					Button("Open original", systemImage: "safari", action: onOpenOriginal)
						.buttonStyle(.borderless)
				} else {
					Label("Original unavailable", systemImage: "link.badge.xmark")
						.foregroundStyle(.secondary)
				}
			}
			.font(.subheadline)

			DisclosureGroup("Why this is here") {
				VStack(alignment: .leading, spacing: 8) {
					HStack(spacing: 10) {
						ScoreBadge(score: article.score)
						Text(article.learningState)
							.foregroundStyle(.secondary)
						Text("\(article.sampleCount) signals")
							.foregroundStyle(.secondary)
					}
					Text(article.explanation)
						.foregroundStyle(.secondary)
						.textSelection(.enabled)
				}
				.font(.subheadline)
				.padding(.top, 4)
			}
			.tint(.secondary)
		}
	}
}
