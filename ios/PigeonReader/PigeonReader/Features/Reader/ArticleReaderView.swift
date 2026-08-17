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
	@State private var scrollPosition = ScrollPosition()
	@State private var pendingRestoredDepth: Double?
	@State private var scrollBoundary = ReaderBoundaryNavigationState(isAtTop: true, isAtBottom: true)
	@State private var boundaryNavigationInProgress = false

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
					let margin = model.readerTypography.horizontalMargin
					let columnWidth = min(
						max(geometry.size.width, 1),
						model.readerTypography.columnWidth + (margin * 2),
					)
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
						.padding(.horizontal, margin)
						.padding(.vertical, 24)
						.frame(width: columnWidth, alignment: .leading)
						.frame(maxWidth: .infinity, alignment: .center)
						.clipped()
						.background {
							ReaderBoundarySwipeRecognizer(
								boundaryState: { scrollBoundary },
								onSwipe: { startedAt, translationX, translationY in
									handleBoundarySwipe(
										startedAt: startedAt,
										translationX: translationX,
										translationY: translationY,
										article: current,
									)
								},
							)
						}
					}
					.accessibilityIdentifier("article-reader-scroll-view")
					.id(ArticleReaderContentIdentity(articleID: current.id, mode: selectedMode))
					.scrollPosition($scrollPosition)
					.scrollBounceBehavior(.basedOnSize, axes: .horizontal)
					.onScrollGeometryChange(for: ArticleScrollGeometry.self) { geometry in
						ArticleScrollGeometry(geometry)
					} action: { _, geometry in
						scrollBoundary = geometry.boundaryState
						if let pendingRestoredDepth, geometry.maximumOffset > 1 {
							scrollPosition.scrollTo(y: pendingRestoredDepth * geometry.maximumOffset)
							self.pendingRestoredDepth = nil
							return
						}
						let depth = min(max(geometry.offset / max(geometry.maximumOffset, 1), 0), 1)
						model.recordScrollDepth(itemId: current.id, depth: depth)
						model.setArticleScrollOffset(depth, for: current.id)
					}
				}
				.background(readerBackground)
			}
		}
		.background(readerBackground)
		.preferredColorScheme(preferredColorScheme)
		.navigationTitle(current.source)
		.navigationBarTitleDisplayMode(.inline)
		.navigationBarBackButtonHidden(true)
		.toolbar {
			ToolbarItemGroup(placement: .topBarTrailing) {
				if let shareURL = current.safeOriginalURL {
					ShareLink(item: shareURL, subject: Text(current.title)) {
						Label("Share", systemImage: "square.and.arrow.up")
					}
					.keyboardShortcut("s", modifiers: [.command, .shift])
					.accessibilityHint("Opens the system share sheet")
				}

				Button(current.isRead ? "Mark unread" : "Mark read", systemImage: current.isRead ? "circle" : "largecircle.fill.circle") {
					Task { await model.setRead(current, read: !current.isRead) }
				}
				.keyboardShortcut("u", modifiers: .command)

				Button(current.isStarred ? "Unstar" : "Star", systemImage: current.isStarred ? "star.fill" : "star") {
					Task { await model.setStarred(current, starred: !current.isStarred) }
				}
				.keyboardShortcut("s", modifiers: .command)

				Menu("Reading controls", systemImage: "textformat.size") {
					Button("Looser lines", systemImage: "arrow.down.to.line") {
						model.readerTypography.increaseLineHeight()
					}
					.disabled(model.readerTypography.lineHeight >= ReaderTypographySettings.lineHeightRange.upperBound)
					Button("Tighter lines", systemImage: "arrow.up.to.line") {
						model.readerTypography.decreaseLineHeight()
					}
					.disabled(model.readerTypography.lineHeight <= ReaderTypographySettings.lineHeightRange.lowerBound)
					Picker("Theme", selection: Binding(
						get: { model.readerTypography.theme },
						set: { model.readerTypography.theme = $0 },
					)) {
						ForEach(ReaderTheme.allCases) { theme in
							Text(theme.title).tag(theme)
						}
					}
					Divider()
					Button("Reset reading controls", systemImage: "arrow.counterclockwise") {
						model.readerTypography.reset()
					}
				}

				Button("More like this", systemImage: "plus.circle") {
					Task { await model.recordPreference(.moreLikeThis, for: current) }
				}

				Menu("Preferences", systemImage: "hand.thumbsup") {
					Button("Not interested", systemImage: "hand.thumbsdown") {
						Task { await model.recordPreference(.notInterested, for: current) }
					}
				}
			}
			ReaderSettingsToolbarItem()
		}
		.task(id: readerModeTaskID(for: current)) {
			selectedMode = model.displayReaderMode(for: current)
			readerDocument = nil
			readerViewState = current.safeOriginalURL == nil ? .unavailable : .idle
		}
		.task(id: readerRequestID(for: current)) {
			await loadReaderViewIfNeeded(for: current)
		}
		.task(id: current.id) {
			boundaryNavigationInProgress = false
			await model.recordExplicitOpen(for: current)
		}
		.task(id: ArticleReaderContentIdentity(articleID: current.id, mode: selectedMode)) {
			scrollPosition = ScrollPosition()
			pendingRestoredDepth = model.articleScrollOffset(for: current.id)
		}
		.task(id: ReadingMonitorID(articleID: current.id, isActive: scenePhase == .active)) {
			guard scenePhase == .active else {
				return
			}
			await model.monitorActiveReading(for: current.id)
		}
		.onChange(of: selectedMode) { _, newMode in
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
				theme: model.readerTypography.theme,
				remoteImagePolicy: model.readerTypography.remoteImagePolicy,
				imageProxySession: model.session,
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
						theme: model.readerTypography.theme,
						remoteImagePolicy: model.readerTypography.remoteImagePolicy,
						imageProxySession: model.session,
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

	private func readerModeTaskID(for article: Recommendation) -> String {
		"\(article.id)|\(article.feedKey)|\(article.safeOriginalURL?.absoluteString ?? "none")"
	}

	private func selectMode(_ mode: ReaderMode) {
		guard mode == .feedContent || currentArticle.safeOriginalURL != nil else {
			return
		}
		selectedMode = mode
		model.setReaderMode(mode, for: currentArticle)
	}

	private func loadReaderViewIfNeeded(for article: Recommendation) async {
		guard selectedMode == .readerView else {
			return
		}
		guard article.safeOriginalURL != nil else {
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
					theme: model.readerTypography.theme,
					remoteImagePolicy: model.readerTypography.remoteImagePolicy,
					imageProxySession: model.session,
					openedDestination: openInlineDestination,
					saveToReader: saveInlineDestination,
				)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func handleBoundarySwipe(
		startedAt: ReaderBoundaryNavigationState,
		translationX: CGFloat,
		translationY: CGFloat,
		article: Recommendation,
	) {
		guard let direction = ReaderBoundaryNavigation.direction(
			startedAt: startedAt,
			translationX: Double(translationX),
			translationY: Double(translationY),
		) else {
			return
		}
		navigateFromBoundary(direction, from: article)
	}

	private func navigateFromBoundary(
		_ direction: ReaderBoundaryNavigationDirection,
		from current: Recommendation,
	) {
		guard boundaryNavigationInProgress == false else {
			return
		}
		let displayedArticles = model.articles(for: model.selectedCollection)
		guard let currentIndex = displayedArticles.firstIndex(where: { $0.id == current.id }),
			let targetIndex = ReaderBoundaryNavigation.targetIndex(
				currentIndex: currentIndex,
				count: displayedArticles.count,
				direction: direction,
			),
			let target = displayedArticles[safe: targetIndex] else {
			return
		}

		boundaryNavigationInProgress = true
		pendingRestoredDepth = model.articleScrollOffset(for: target.id)
		scrollPosition = ScrollPosition()
		model.select(article: target)
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

	private var preferredColorScheme: ColorScheme? {
		switch model.readerTypography.theme {
		case .system: nil
		case .light, .sepia: .light
		case .darkGray, .dark: .dark
		}
	}

	private var readerBackground: Color {
		switch model.readerTypography.theme {
		case .sepia:
			Color(red: 0.965, green: 0.925, blue: 0.82)
		case .darkGray:
			Color(red: 28.0 / 255.0, green: 28.0 / 255.0, blue: 30.0 / 255.0)
		case .system, .light, .dark:
			Color(uiColor: .systemBackground)
		}
	}
}

private extension Collection {
	subscript(safe index: Index) -> Element? {
		indices.contains(index) ? self[index] : nil
	}
}

private struct ArticleScrollGeometry: Equatable {
	let offset: CGFloat
	let maximumOffset: CGFloat
	let visibleMinY: CGFloat
	let visibleMaxY: CGFloat
	let contentHeight: CGFloat

	init(_ geometry: ScrollGeometry) {
		offset = geometry.contentOffset.y
		maximumOffset = max(
			geometry.contentSize.height + geometry.contentInsets.bottom - geometry.containerSize.height,
			0,
		)
		visibleMinY = geometry.visibleRect.minY
		visibleMaxY = geometry.visibleRect.maxY
		contentHeight = geometry.contentSize.height
	}

	var boundaryState: ReaderBoundaryNavigationState {
		let boundaryTolerance = 2.0
		return ReaderBoundaryNavigationState(
			isAtTop: offset <= boundaryTolerance || visibleMinY <= boundaryTolerance,
			isAtBottom: offset >= maximumOffset - boundaryTolerance || visibleMaxY >= contentHeight - boundaryTolerance,
		)
	}
}
