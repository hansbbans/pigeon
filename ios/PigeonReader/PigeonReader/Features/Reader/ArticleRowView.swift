import SwiftUI

struct ArticleRowView: View {
	let article: Recommendation

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(alignment: .firstTextBaseline, spacing: 7) {
				if !article.isRead {
					Circle()
						.fill(.tint)
						.frame(width: 6, height: 6)
						.accessibilityHidden(true)
				}
				Text(article.title)
					.font(.body.weight(.semibold))
					.lineLimit(2)
				Spacer(minLength: 4)
					if article.sampleCount > 0 || article.score > 0 {
						ScoreBadge(score: article.score)
					}
			}

			HStack(spacing: 6) {
				Text(article.source)
					.font(.caption.weight(.semibold))
					.foregroundStyle(.primary)
				Text(article.receivedAt, format: .relative(presentation: .named))
					.font(.caption)
					.foregroundStyle(.secondary)
				Spacer()
				if article.isStarred {
					Image(systemName: "star.fill")
						.font(.caption)
						.foregroundStyle(.orange)
						.accessibilityLabel("Starred")
				}
			}

			Text(article.explanation)
				.font(.caption)
				.foregroundStyle(.secondary)
				.lineLimit(1)
				.accessibilityLabel("Why this is here: \(article.explanation)")
		}
		.padding(.vertical, 3)
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
	}
}
