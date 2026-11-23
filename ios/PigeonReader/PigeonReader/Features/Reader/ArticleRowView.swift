import SwiftUI

struct ArticleRowView: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.showsReadingTime) private var showsReadingTime
	let article: Recommendation
	let density: ReaderTimelineDensity
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let thumbnailStore: ReaderFeedThumbnailStore?
	let thumbnailScope: String?
	let imageProxySession: PigeonSession?
	/// Off in a feed's own sections, where every story is from that feed.
	let showsFeedName: Bool
	/// A story already read when the list first showed it: one muted line.
	/// A story read while the list is open keeps its height (see
	/// `ReaderFullRowMemory`).
	let isCompact: Bool
	let select: (() -> Void)?
	@State private var thumbnailState = ArticleRowThumbnailState()

	init(
		article: Recommendation,
		density: ReaderTimelineDensity = .comfortable,
		remoteImagePolicy: ReaderRemoteImagePolicy = .normal,
		thumbnailStore: ReaderFeedThumbnailStore? = nil,
		thumbnailScope: String? = nil,
		imageProxySession: PigeonSession? = nil,
		showsFeedName: Bool = true,
		isCompact: Bool = false,
		select: (() -> Void)? = nil,
	) {
		self.article = article
		self.density = density
		self.remoteImagePolicy = remoteImagePolicy
		self.thumbnailStore = thumbnailStore
		self.thumbnailScope = thumbnailScope
		self.imageProxySession = imageProxySession
		self.showsFeedName = showsFeedName
		self.isCompact = isCompact
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
			if showsThumbnail, thumbnailPresentation == .askToLoad {
				thumbnail
			}
		}
		.padding(.vertical, density == .titleOnly || isCompact ? 1 : 3)
		.frame(maxWidth: .infinity, alignment: .leading)
		.animation(ReaderMotion.animation(reduceMotion: reduceMotion), value: article.isRead)
		.task(id: thumbnailRequest) {
			let request = thumbnailRequest
			guard thumbnailState.activate(request) else { return }
			let selectedURL = await Task.detached(priority: .utility) {
				request.selectURL()
			}.value
			guard Task.isCancelled == false, request == thumbnailRequest else { return }
			thumbnailState.completeSelection(selectedURL, for: request)
		}
	}

	private var thumbnailRequest: ArticleRowThumbnailRequest {
		ArticleRowThumbnailRequest(
			articleID: article.id,
			html: article.html,
			baseURL: article.safeOriginalURL,
			scope: imageProxySession?.storageIdentity ?? thumbnailScope,
			policy: remoteImagePolicy,
			isImageRich: showsThumbnail,
		)
	}

	private var currentThumbnailURL: URL? {
		thumbnailState.url(for: thumbnailRequest)
	}

	private var thumbnailPresentation: ArticleImagePolicy.ListThumbnail {
		ArticleImagePolicy.listThumbnail(
			policy: remoteImagePolicy,
			thumbnailURL: currentThumbnailURL,
			didRequestBlockedLoad: thumbnailState.requestedBlockedLoad(for: thumbnailRequest),
		)
	}

	private var selectableContent: some View {
		HStack(alignment: .top, spacing: 10) {
			storyText
			if showsThumbnail, thumbnailPresentation != .askToLoad {
				thumbnail
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
		.accessibilityValue(accessibilityValue)
	}

	private var showsThumbnail: Bool {
		density == .imageRich && isCompact == false
	}

	private var titleLineLimit: Int {
		density == .titleOnly || isCompact ? 1 : 2
	}

	private var storyText: some View {
		VStack(alignment: .leading, spacing: density == .compact || isCompact ? 1 : 3) {
			HStack(alignment: .firstTextBaseline, spacing: 7) {
				// Read is a change of weight and colour, never a fade: faded text
				// fell under 4.5:1.
				PaywallLabel.title(article.title, isPaywalled: article.isPaywalled)
					.font(article.isRead ? ReaderTypography.listReadTitle : ReaderTypography.listTitle)
					.foregroundStyle(article.isRead ? Color.pigeonSecondary : Color.primary)
					.lineLimit(titleLineLimit)
				Spacer(minLength: 4)
				if article.sampleCount > 0 || article.score > 0 {
					ScoreBadge(score: article.score)
				}
			}

			if density != .titleOnly {
				HStack(spacing: 5) {
					// The feed name gives way first; a narrow iPad column must not
					// wrap the date under it.
					if showsFeedName {
						Text(article.source)
							.font(ReaderTypography.listMeta.weight(.medium))
							.foregroundStyle(article.isRead ? Color.pigeonSecondary : Color.primary)
							.lineLimit(1)
						Text("·")
							.font(ReaderTypography.listMeta)
							.foregroundStyle(.pigeonSecondary)
							.accessibilityHidden(true)
					}
					Text(article.receivedAt, format: .relative(presentation: .named))
						.font(ReaderTypography.listMeta)
						.foregroundStyle(.pigeonSecondary)
						.lineLimit(1)
						.layoutPriority(1)
					if let readingLength {
						Text("· \(readingLength)")
							.font(ReaderTypography.listMeta)
							.foregroundStyle(.pigeonSecondary)
							.lineLimit(1)
							.layoutPriority(1)
					}
					Spacer()
				Image(systemName: "star.fill")
					.font(.caption)
					.foregroundStyle(.pigeonKeep)
					.opacity(article.isStarred ? 1 : 0)
					.animation(ReaderMotion.animation(reduceMotion: reduceMotion), value: article.isStarred)
					.accessibilityLabel("Starred")
					.accessibilityHidden(article.isStarred == false)
				}
			}

			if (density == .comfortable || density == .imageRich), isCompact == false, shouldShowExplanation {
				Text(article.explanation)
					.font(ReaderTypography.listMeta)
					.foregroundStyle(.pigeonSecondary)
					.lineLimit(1)
					.accessibilityLabel("Why this is here: \(article.explanation)")
			}
		}
	}

	private var readingLength: String? {
		article.readingLengthLabel(showsReadingTime: showsReadingTime)
	}

	private var accessibilityValue: String {
		var parts = [article.isRead ? "Read" : "Unread"]
		if article.isPaywalled == true { parts.append(PaywallLabel.accessibilityValue) }
		if let readingLength { parts.append(readingLength) }
		return parts.joined(separator: ", ")
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
			let url = currentThumbnailURL {
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
				thumbnailState.requestBlockedLoad(for: thumbnailRequest)
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
				.foregroundStyle(.pigeonSecondary)
		}
		.clipShape(.rect(cornerRadius: 8))
		.accessibilityHidden(true)
	}
}
