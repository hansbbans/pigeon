import SwiftUI

struct ArticleRowView: View {
	let article: Recommendation
	let density: ReaderTimelineDensity
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let imageProxySession: PigeonSession?

	init(
		article: Recommendation,
		density: ReaderTimelineDensity = .comfortable,
		remoteImagePolicy: ReaderRemoteImagePolicy = .normal,
		imageProxySession: PigeonSession? = nil,
	) {
		self.article = article
		self.density = density
		self.remoteImagePolicy = remoteImagePolicy
		self.imageProxySession = imageProxySession
	}

	var body: some View {
		HStack(alignment: .top, spacing: 10) {
			storyText
			if density == .imageRich {
				thumbnail
			}
		}
		.padding(.vertical, density == .titleOnly ? 1 : 3)
		.frame(maxWidth: .infinity, alignment: .leading)
		.opacity(article.isRead ? 0.55 : 1)
		.accessibilityElement(children: .combine)
		.accessibilityValue(article.isRead ? "Read" : "Unread")
	}

	private var storyText: some View {
		VStack(alignment: .leading, spacing: density == .compact ? 2 : 4) {
			HStack(alignment: .firstTextBaseline, spacing: 7) {
				Text(article.title)
					.font(.body.weight(.semibold))
					.lineLimit(density == .titleOnly ? 1 : 2)
				Spacer(minLength: 4)
				if article.sampleCount > 0 || article.score > 0 {
					ScoreBadge(score: article.score)
				}
			}

			if density != .titleOnly {
				HStack(spacing: 6) {
					Text(article.author ?? article.source)
						.font(.caption.weight(.semibold))
						.foregroundStyle(.primary)
					if article.author != nil {
						Text(article.source)
							.font(.caption)
							.foregroundStyle(.secondary)
					}
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
			}

			if density == .comfortable || density == .imageRich {
				Text(article.explanation)
					.font(.caption)
					.foregroundStyle(.secondary)
					.lineLimit(1)
					.accessibilityLabel("Why this is here: \(article.explanation)")
			}
		}
	}

	@ViewBuilder
	private var thumbnail: some View {
		if let url = ArticleListThumbnailRequest.thumbnailURL(
			in: article.html,
			baseURL: article.safeOriginalURL,
		) {
			ArticleListThumbnailView(
				remoteURL: url,
				policy: remoteImagePolicy,
				session: imageProxySession,
			)
		} else {
			imagePlaceholder
				.frame(width: 72, height: 54)
		}
	}

	private var imagePlaceholder: some View {
		ZStack {
			Color.secondary.opacity(0.1)
			Image(systemName: remoteImagePolicy == .blocked ? "photo.badge.shield.exclamationmark" : "photo")
				.foregroundStyle(.secondary)
		}
		.clipShape(.rect(cornerRadius: 8))
		.accessibilityHidden(true)
	}
}
