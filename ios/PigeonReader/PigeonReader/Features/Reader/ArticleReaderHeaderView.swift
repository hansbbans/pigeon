import SwiftUI

struct ArticleReaderHeaderView: View {
	let article: Recommendation
	let selectedMode: ReaderMode
	let hasOriginalURL: Bool
	let onSelectMode: (ReaderMode) -> Void
	let onOpenOriginal: () -> Void

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

			Text(article.title)
				.font(ReaderTypography.articleTitle)
				.bold()
				.textSelection(.enabled)

			HStack(spacing: 10) {
				Menu {
					ForEach(ReaderMode.allCases) { mode in
						Button {
							onSelectMode(mode)
						} label: {
							Label(mode.title, systemImage: mode.systemImage)
						}
						.disabled(mode != .feedContent && hasOriginalURL == false)
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
