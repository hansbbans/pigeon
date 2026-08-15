import Foundation
import SwiftUI

struct ArticleReaderView: View {
	let article: Recommendation
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.openURL) private var openURL
	@Environment(\.scenePhase) private var scenePhase
	@State private var selectedMode = ReaderMode.feedContent
	@State private var readerDocument: ReaderViewDocument?
	@State private var readerViewState = ReaderViewLoadState.idle

	private var currentArticle: Recommendation {
		model.article(withId: article.id) ?? article
	}

	var body: some View {
		let current = currentArticle
		VStack(spacing: 0) {
			if selectedMode == .website, let originalURL = current.safeOriginalURL {
				VStack(spacing: 0) {
					ArticleReaderHeaderView(
						article: current,
						selectedMode: selectedMode,
						hasOriginalURL: true,
						onSelectMode: selectMode,
						onOpenOriginal: openOriginal,
					)
					.padding(.horizontal)
					.padding(.vertical, 16)
					Divider()

					ArticleWebsiteView(articleID: current.id, url: originalURL)
						.frame(maxWidth: .infinity, maxHeight: .infinity)
				}
			} else {
				GeometryReader { geometry in
					let columnWidth = min(max(geometry.size.width, 1), 720)
					ScrollView(.vertical) {
						VStack(alignment: .leading, spacing: 18) {
							ArticleReaderHeaderView(
								article: current,
								selectedMode: selectedMode,
								hasOriginalURL: current.safeOriginalURL != nil,
								onSelectMode: selectMode,
								onOpenOriginal: openOriginal,
							)

							Divider()

							articleContent(for: current)
						}
						.padding(.horizontal, 16)
						.padding(.vertical, 24)
						.frame(width: columnWidth, alignment: .leading)
						.frame(maxWidth: .infinity, alignment: .center)
						.clipped()
					}
					.scrollBounceBehavior(.basedOnSize, axes: .horizontal)
					.onScrollGeometryChange(for: CGFloat.self) { geometry in
						let maximumOffset = max(geometry.contentSize.height - geometry.containerSize.height, 1)
						return min(max(geometry.contentOffset.y / maximumOffset, 0), 1)
					} action: { _, depth in
						model.recordScrollDepth(itemId: current.id, depth: depth)
					}
				}
				.background(.background)
			}
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

				Menu("Reading controls", systemImage: "textformat.size") {
					Button("Larger text", systemImage: "textformat.size.larger") {
						model.readerTypography.increaseTextScale()
					}
					.disabled(model.readerTypography.textScale >= ReaderTypographySettings.textScaleRange.upperBound)
					Button("Smaller text", systemImage: "textformat.size.smaller") {
						model.readerTypography.decreaseTextScale()
					}
					.disabled(model.readerTypography.textScale <= ReaderTypographySettings.textScaleRange.lowerBound)
					Button("Looser lines", systemImage: "arrow.down.to.line") {
						model.readerTypography.increaseLineHeight()
					}
					.disabled(model.readerTypography.lineHeight >= ReaderTypographySettings.lineHeightRange.upperBound)
					Button("Tighter lines", systemImage: "arrow.up.to.line") {
						model.readerTypography.decreaseLineHeight()
					}
					.disabled(model.readerTypography.lineHeight <= ReaderTypographySettings.lineHeightRange.lowerBound)
					Divider()
					Button("Reset reading controls", systemImage: "arrow.counterclockwise") {
						model.readerTypography.reset()
					}
				}

				Menu("Preferences", systemImage: "hand.thumbsup") {
					Button("More like this", systemImage: "plus.circle") {
						Task { await model.recordPreference(.moreLikeThis, for: current) }
					}
					Button("Not interested", systemImage: "hand.thumbsdown") {
						Task { await model.recordPreference(.notInterested, for: current) }
					}
				}
			}
		}
		.task(id: current.feedKey) {
			selectedMode = current.safeOriginalURL == nil ? .feedContent : model.readerMode(for: current.feedKey)
			readerDocument = nil
			readerViewState = current.safeOriginalURL == nil ? .unavailable : .idle
		}
		.task(id: readerRequestID(for: current)) {
			await loadReaderViewIfNeeded(for: current)
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
		.onChange(of: selectedMode) { _, newMode in
			model.setReaderMode(newMode, for: current.feedKey)
			if newMode != .readerView {
				readerViewState = newMode == .feedContent ? .idle : .unavailable
			}
		}
	}

	@ViewBuilder
	private func articleContent(for article: Recommendation) -> some View {
		switch selectedMode {
		case .feedContent:
			ArticleBodyView(
				content: article.html,
				fallbackText: article.text ?? article.title,
				baseURL: article.safeOriginalURL,
				leadImageURL: nil,
				textScale: model.readerTypography.textScale,
				lineHeight: model.readerTypography.lineHeight,
				openedDestination: openInlineDestination,
				saveToReader: saveInlineDestination,
			)
		case .readerView:
			readerViewContent(for: article)
		case .website:
			EmptyView()
		}
	}

	@ViewBuilder
	private func readerViewContent(for article: Recommendation) -> some View {
		switch readerViewState {
		case .idle, .loading:
			ProgressView("Preparing Reader View")
				.frame(maxWidth: .infinity, minHeight: 160)
		case .unavailable:
			ContentUnavailableView(
				"Reader View unavailable",
				systemImage: "book.pages",
				description: Text("This article does not have an original web address."),
			)
		case .failed(let message):
			readerViewFailure(message: message, article: article, showingFeedContent: false)
		case .fallback(let message):
			readerViewFailure(message: message, article: article, showingFeedContent: true)
		case .loaded:
			if let readerDocument {
				VStack(alignment: .leading, spacing: 12) {
					if let byline = readerDocument.byline {
						Text(byline)
							.font(.subheadline)
							.foregroundStyle(.secondary)
					}
					ArticleBodyView(
						content: readerDocument.contentHTML,
						fallbackText: readerDocument.excerpt ?? article.text ?? article.title,
						baseURL: article.safeOriginalURL,
						leadImageURL: readerDocument.leadImageURL,
						textScale: model.readerTypography.textScale,
						lineHeight: model.readerTypography.lineHeight,
						openedDestination: openInlineDestination,
						saveToReader: saveInlineDestination,
					)
				}
				.accessibilityElement(children: .contain)
				.accessibilityIdentifier("reader-view-loaded-content")
			} else {
				Text("Reader View returned no article content.")
					.foregroundStyle(.secondary)
			}
		}
	}

	private func readerRequestID(for article: Recommendation) -> String {
		"\(article.id)|\(selectedMode.rawValue)|\(article.safeOriginalURL?.absoluteString ?? "none")"
	}

	private func selectMode(_ mode: ReaderMode) {
		guard mode == .feedContent || currentArticle.safeOriginalURL != nil else {
			return
		}
		selectedMode = mode
	}

	private func loadReaderViewIfNeeded(for article: Recommendation) async {
		guard selectedMode == .readerView else {
			return
		}
		guard let originalURL = article.safeOriginalURL else {
			readerViewState = .unavailable
			return
		}

		readerViewState = .loading
		do {
			let document = try await model.loadReaderView(for: article)
			try Task.checkCancellation()
			readerDocument = document
			readerViewState = .loaded
		} catch is CancellationError {
			return
		} catch {
			let hasFeedContent = article.html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
			readerViewState = hasFeedContent ? .fallback(error.localizedDescription) : .failed(error.localizedDescription)
		}
	}

	@ViewBuilder
	private func readerViewFailure(message: String, article: Recommendation, showingFeedContent: Bool) -> some View {
		VStack(alignment: .leading, spacing: 12) {
			Label("Reader View unavailable", systemImage: "exclamationmark.triangle")
				.font(.headline)
			Text(message)
				.foregroundStyle(.secondary)
			Button("Use Feed Content") {
				selectMode(.feedContent)
			}
			.buttonStyle(.borderedProminent)
			if showingFeedContent {
				ArticleBodyView(
					content: article.html,
					fallbackText: article.text ?? article.title,
					baseURL: article.safeOriginalURL,
					leadImageURL: nil,
					textScale: model.readerTypography.textScale,
					lineHeight: model.readerTypography.lineHeight,
					openedDestination: openInlineDestination,
					saveToReader: saveInlineDestination,
				)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func openOriginal() {
		guard let url = currentArticle.safeOriginalURL, let destination = OutboundDestination(url: url) else {
			return
		}
		Task { await model.recordOutboundClick(itemId: currentArticle.id, destinationHost: destination.host) }
		openURL(url)
	}

	private func openInlineDestination(_ destination: OutboundDestination) {
		Task {
			await model.recordOutboundClick(itemId: currentArticle.id, destinationHost: destination.host)
		}
	}

	private func saveInlineDestination(_ destination: OutboundDestination) async throws -> ReadwiseSaveOutcome {
		try await model.saveToReader(destination)
	}
}
