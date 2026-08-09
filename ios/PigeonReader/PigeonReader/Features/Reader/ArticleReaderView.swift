import Foundation
import SwiftUI

struct ArticleReaderView: View {
	let article: Recommendation
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.openURL) private var openURL
	@Environment(\.scenePhase) private var scenePhase
	@State private var renderedContent: AttributedString?

	private var currentArticle: Recommendation {
		model.article(withId: article.id) ?? article
	}

	var body: some View {
		let current = currentArticle

		ScrollView {
			VStack(alignment: .leading, spacing: 16) {
				VStack(alignment: .leading, spacing: 8) {
					Text(current.source)
						.font(.subheadline.weight(.semibold))
						.foregroundStyle(.tint)
					Text(current.title)
						.font(ReaderTypography.articleTitle)
						.textSelection(.enabled)
					Text(current.receivedAt, format: .dateTime.month(.wide).day().year().hour().minute())
						.font(.subheadline)
						.foregroundStyle(.secondary)
					HStack(spacing: 12) {
						ScoreBadge(score: current.score)
						Text(current.learningState)
							.font(.caption)
							.foregroundStyle(.secondary)
						Text("\(current.sampleCount) signals")
							.font(.caption)
							.foregroundStyle(.secondary)
					}
					Text(current.explanation)
						.font(.subheadline)
						.foregroundStyle(.secondary)
				}

				Divider()

				if let renderedContent {
					ArticleBodyView(content: renderedContent, openedDestination: openInlineDestination)
				} else {
					ProgressView("Preparing article")
				}

				if let url = current.safeOriginalURL, let destination = OutboundDestination(url: url) {
					Button("Open original", systemImage: "safari") {
						Task { await model.recordOutboundClick(itemId: current.id, destinationHost: destination.host) }
						openURL(url)
					}
					.buttonStyle(.bordered)
					.keyboardShortcut("o", modifiers: .command)
				}
			}
			.padding(.horizontal)
			.padding(.vertical, 24)
			.frame(maxWidth: 680)
			.frame(maxWidth: .infinity)
		}
		.background(.background)
		.navigationTitle(current.source)
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			ToolbarItemGroup(placement: .topBarTrailing) {
				Button(current.isRead ? "Mark unread" : "Mark read", systemImage: current.isRead ? "envelope.badge" : "checkmark.circle") {
					Task { await model.setRead(current, read: !current.isRead) }
				}
				.keyboardShortcut("u", modifiers: .command)
				Button(current.isStarred ? "Unstar" : "Star", systemImage: current.isStarred ? "star.fill" : "star") {
					Task { await model.setStarred(current, starred: !current.isStarred) }
				}
				.keyboardShortcut("s", modifiers: .command)
				Menu("Preferences", systemImage: "hand.thumbsup") {
					Button("More like this", systemImage: "plus.circle") {
						Task { await model.recordPreference(.moreLikeThis, for: current) }
					}
					Button("Not interested", systemImage: "hand.thumbsdown") {
						Task { await model.recordPreference(.notInterested, for: current) }
					}
				}
			}
			ToolbarItemGroup(placement: .bottomBar) {
				Button("Previous Story", systemImage: "chevron.left") {
					model.selectAdjacentArticle(offset: -1)
				}
				.keyboardShortcut("[", modifiers: .command)
				.disabled(model.canSelectAdjacentArticle(offset: -1) == false)
				Spacer()
				Text("Swipe to move between stories")
					.font(.caption)
					.foregroundStyle(.secondary)
					.accessibilityHidden(true)
				Spacer()
				Button("Next Story", systemImage: "chevron.right") {
					model.selectAdjacentArticle(offset: 1)
				}
				.keyboardShortcut("]", modifiers: .command)
				.disabled(model.canSelectAdjacentArticle(offset: 1) == false)
			}
		}
		.simultaneousGesture(articleTraversalGesture)
		.accessibilityAction(named: "Previous Story") {
			model.selectAdjacentArticle(offset: -1)
		}
		.accessibilityAction(named: "Next Story") {
			model.selectAdjacentArticle(offset: 1)
		}
		.onScrollGeometryChange(for: CGFloat.self) { geometry in
			let maximumOffset = max(geometry.contentSize.height - geometry.containerSize.height, 1)
			return min(max(geometry.contentOffset.y / maximumOffset, 0), 1)
		} action: { _, depth in
			model.recordScrollDepth(itemId: current.id, depth: depth)
		}
		.task(id: current.html) {
			renderedContent = makeAttributedContent(from: current)
		}
		.task(id: current.id) {
			await model.recordExplicitOpen(for: current)
		}
		.task(id: ReadingMonitorID(articleID: current.id, isActive: scenePhase == .active)) {
			guard scenePhase == .active else {
				return
			}
			await model.monitorActiveReading(for: current.id)
		}
	}

	private func openInlineDestination(_ destination: OutboundDestination) {
		Task {
			await model.recordOutboundClick(itemId: currentArticle.id, destinationHost: destination.host)
		}
	}

	private func makeAttributedContent(from article: Recommendation) -> AttributedString {
		ArticleContentFormatter.make(html: article.html, fallback: article.text ?? article.title)
	}

	private var articleTraversalGesture: some Gesture {
		DragGesture(minimumDistance: 40)
			.onEnded { value in
				let horizontal = value.predictedEndTranslation.width
				let vertical = value.predictedEndTranslation.height
				guard abs(horizontal) > 90, abs(horizontal) > abs(vertical) * 1.35 else {
					return
				}
				model.selectAdjacentArticle(offset: horizontal < 0 ? 1 : -1)
			}
	}
}
