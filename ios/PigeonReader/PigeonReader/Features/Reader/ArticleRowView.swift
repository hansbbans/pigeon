import SwiftUI

struct ArticleRowView: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	let article: Recommendation
	let density: ReaderTimelineDensity
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let thumbnailStore: ReaderFeedThumbnailStore?
	let thumbnailScope: String?
	let imageProxySession: PigeonSession?
	let select: (() -> Void)?
	@State private var didRequestBlockedThumbnail = false

	init(
		article: Recommendation,
		density: ReaderTimelineDensity = .comfortable,
		remoteImagePolicy: ReaderRemoteImagePolicy = .normal,
		thumbnailStore: ReaderFeedThumbnailStore? = nil,
		thumbnailScope: String? = nil,
		imageProxySession: PigeonSession? = nil,
		select: (() -> Void)? = nil,
	) {
		self.article = article
		self.density = density
		self.remoteImagePolicy = remoteImagePolicy
		self.thumbnailStore = thumbnailStore
		self.thumbnailScope = thumbnailScope
		self.imageProxySession = imageProxySession
		self.select = select
	}

	var body: some View {
		HStack(alignment: .top, spacing: 10) {
			if let select {
				Button(action: select) {
					selectableContent
				}
				.buttonStyle(ReaderRowButtonStyle())
			} else {
				selectableContent
			}
			if density == .imageRich, thumbnailPresentation == .askToLoad {
				thumbnail
			}
		}
		.padding(.vertical, density == .titleOnly ? 1 : 3)
		.frame(maxWidth: .infinity, alignment: .leading)
		.opacity(article.isRead ? 0.55 : 1)
		.animation(ReaderMotion.animation(reduceMotion: reduceMotion), value: article.isRead)
	}

	private var thumbnailPresentation: ArticleImagePolicy.ListThumbnail {
		ArticleImagePolicy.listThumbnail(
			policy: remoteImagePolicy,
			html: article.html,
			baseURL: article.safeOriginalURL,
			didRequestBlockedLoad: didRequestBlockedThumbnail,
		)
	}

	private var selectableContent: some View {
		HStack(alignment: .top, spacing: 10) {
			storyText
			if density == .imageRich, thumbnailPresentation != .askToLoad {
				thumbnail
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
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
					Text(article.displayAuthor ?? article.source)
						.font(.caption.weight(.semibold))
						.foregroundStyle(.primary)
					if article.displayAuthor != nil {
						Text(article.source)
							.font(.caption)
							.foregroundStyle(.secondary)
					}
					Text(article.receivedAt, format: .relative(presentation: .named))
						.font(.caption)
						.foregroundStyle(.secondary)
					Spacer()
				Image(systemName: "star.fill")
					.font(.caption)
					.foregroundStyle(.orange)
					.opacity(article.isStarred ? 1 : 0)
					.animation(ReaderMotion.animation(reduceMotion: reduceMotion), value: article.isStarred)
					.accessibilityLabel("Starred")
					.accessibilityHidden(article.isStarred == false)
				}
			}

			if (density == .comfortable || density == .imageRich) && shouldShowExplanation {
				Text(article.explanation)
					.font(.caption)
					.foregroundStyle(.secondary)
					.lineLimit(1)
					.accessibilityLabel("Why this is here: \(article.explanation)")
			}
		}
	}

	private var shouldShowExplanation: Bool {
		Self.shouldShowExplanation(explanation: article.explanation, source: article.source)
	}

	nonisolated static func shouldShowExplanation(explanation: String, source: String) -> Bool {
		let normalizedExplanation = explanation.trimmingCharacters(in: .whitespacesAndNewlines)
		let normalizedSource = source.trimmingCharacters(in: .whitespacesAndNewlines)
		guard normalizedSource.isEmpty == false else { return true }
		return normalizedExplanation.caseInsensitiveCompare("From \(normalizedSource)") != .orderedSame
	}

	@ViewBuilder
	private var thumbnail: some View {
		if remoteImagePolicy == .privacyProxied,
			let url = ArticleListThumbnailRequest.thumbnailURL(in: article.html, baseURL: article.safeOriginalURL) {
			ArticleListThumbnailView(remoteURL: url, policy: remoteImagePolicy, session: imageProxySession)
		} else {
			thumbnailContent
		}
	}

	@ViewBuilder
	private var thumbnailContent: some View {
		switch thumbnailPresentation {
		case .remote(let url):
			if remoteImagePolicy == .blocked {
				AsyncImage(url: url) { image in
					image.resizable().scaledToFill()
				} placeholder: {
					imagePlaceholder
				}
				.frame(width: 72, height: 54)
				.clipShape(.rect(cornerRadius: 8))
				.accessibilityLabel("Article image")
			} else {
				ArticleThumbnailView(
					article: article,
					remoteImagePolicy: remoteImagePolicy,
					thumbnailStore: thumbnailStore,
					thumbnailScope: thumbnailScope,
				)
			}
		case .askToLoad:
			Button {
				didRequestBlockedThumbnail = true
			} label: {
				imagePlaceholder
					.frame(width: 72, height: 54)
			}
			.buttonStyle(.borderless)
			.contentShape(Rectangle())
			.accessibilityLabel("Load this remote image")
			.accessibilityHint("Loads only this thumbnail. The publisher may see your network address.")
			.accessibilityIdentifier("image-rich-ask-before-loading")
		case .placeholder:
			ArticleThumbnailView(
				article: article,
				remoteImagePolicy: remoteImagePolicy,
				thumbnailStore: thumbnailStore,
				thumbnailScope: thumbnailScope,
			)
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
