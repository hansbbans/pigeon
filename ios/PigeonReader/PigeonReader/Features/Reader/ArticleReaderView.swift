import Foundation
import SwiftUI
import UIKit

struct ArticleReaderView: View {
	let article: Recommendation
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.horizontalSizeClass) private var horizontalSizeClass
	@Environment(\.openURL) private var openURL
	@Environment(\.scenePhase) private var scenePhase
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var selectedMode = ReaderMode.feedContent
	@State private var activeArticleID: String?
	@State private var readerDocument: ReaderViewDocument?
	@State private var readerDocumentArticleID: String?
	@State private var readerViewArticleID: String?
	@State private var readerViewState = ReaderViewLoadState.idle
	@State private var scrollPosition = ScrollPosition()
	@State private var pendingRestoredDepth: Double?
	@State private var pendingReaderAnchor: ReaderAnchorRequest?
	@State private var readerLayouts: [String: ReaderHTMLLayout] = [:]
	@State private var readerAnchors: [String: ReaderScrollAnchor] = [:]
	@State private var outerScrollOffset: CGFloat = 0
	@State private var articleBodyFrameMinY: CGFloat?
	@State private var articleBodyContentOrigin: CGFloat?
	@State private var isScrollInteractionActive = false
	@State private var boundaryPullController = ReaderBoundaryPullController()
	@State private var boundaryNavigationInProgress = false
	@State private var modeResolutionArticleID: String?
	@State private var restoredModeForArticle: ReaderMode?
	@State private var isArticleBodyLaidOut = false
	@State private var isShowingReadingSettings = false
	@State private var saveConfirmation: ReaderSaveConfirmation?

	private var currentArticle: Recommendation {
		model.article(withId: article.id) ?? article
	}

	private var isShowingArticleBody: Bool {
		switch readerMode(for: currentArticle) {
		case .feedContent, .readerView:
			true
		case .website:
			false
		}
	}

	var body: some View {
		let current = currentArticle
		let visibleMode = readerMode(for: current)
		VStack(spacing: 0) {
			compactBackBar
			if visibleMode == .website, let originalURL = current.safeOriginalURL {
				VStack(spacing: 0) {
					ArticleReaderHeaderView(
						article: current,
						selectedMode: visibleMode,
						hasOriginalURL: true,
						textScale: model.readerTypography.textScale,
						canUseReaderView: YouTubeVideo(url: current.safeOriginalURL) == nil,
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
				ReaderBoundaryPullContainer(controller: boundaryPullController) {
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
								selectedMode: visibleMode,
								hasOriginalURL: current.safeOriginalURL != nil,
								textScale: model.readerTypography.textScale,
									canUseReaderView: YouTubeVideo(url: current.safeOriginalURL) == nil,
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
									boundaryState: { boundaryPullController.boundaryState },
									onPullBegan: { startedAt, direction in
										beginBoundaryPull(
											startedAt: startedAt,
											direction: direction,
											article: current,
										)
									},
									onPullChanged: { startedAt, direction, translationX, translationY in
										updateBoundaryPull(
											startedAt: startedAt,
											direction: direction,
											translationX: translationX,
											translationY: translationY,
											article: current,
										)
									},
									onPullEnded: { startedAt, direction, translationX, translationY in
										endBoundaryPull(
											startedAt: startedAt,
											direction: direction,
											translationX: translationX,
											translationY: translationY,
											article: current,
										)
									},
									onPullCancelled: cancelBoundaryPull,
								)
							}
						}
						.accessibilityIdentifier("article-reader-scroll-view")
						.coordinateSpace(name: ReaderScrollCoordinateSpace.name)
						.scrollPosition($scrollPosition)
						.scrollBounceBehavior(.basedOnSize, axes: .horizontal)
						.onScrollGeometryChange(for: ArticleScrollGeometry.self) { geometry in
							ArticleScrollGeometry(geometry)
						} action: { _, geometry in
							boundaryPullController.boundaryState = geometry.boundaryState
							outerScrollOffset = geometry.offset
							updateReaderAnchor(
								for: current,
								mode: visibleMode,
								geometry: geometry,
							)
							if restorePendingReaderAnchor(for: current, mode: visibleMode, geometry: geometry) {
								return
							}
							let isBodyLaidOut = isArticleBodyLaidOut && isShowingArticleBody
							if let pendingRestoredDepth, geometry.maximumOffset > 1,
								pendingReaderAnchor == nil,
								isScrollInteractionActive == false {
								scrollPosition.scrollTo(y: pendingRestoredDepth * geometry.maximumOffset)
								self.pendingRestoredDepth = nil
								return
							}
							guard ArticleReadingProgress.shouldConsumePendingRestoredDepth(
								pendingDepth: pendingRestoredDepth,
								maximumOffset: Double(geometry.maximumOffset),
								isBodyLaidOut: isBodyLaidOut,
							) else {
								return
							}
							self.pendingRestoredDepth = nil
							let depth = ArticleReadingProgress.depth(
								offset: Double(geometry.offset),
								maximumOffset: Double(geometry.maximumOffset),
								contentHeight: Double(geometry.contentHeight),
								isBodyLaidOut: isBodyLaidOut,
							)
							if isBodyLaidOut {
								model.recordScrollDepth(itemId: current.id, depth: depth)
								model.setArticleScrollOffset(depth, for: current.id)
							}
						}
						.onScrollPhaseChange { _, phase in
							isScrollInteractionActive = phase != .idle
							if phase == .tracking || phase == .interacting {
								pendingReaderAnchor = nil
								pendingRestoredDepth = nil
							}
							if phase == .idle {
								_ = restorePendingReaderAnchor(for: current, mode: visibleMode, geometry: nil)
							}
						}
					}
					.id(current.id)
					.background(readerBackground)
				}
			}
		}
		.background(readerBackground)
		.readerThemeColorScheme(
			ReaderThemeColorSchemePlacement.resolve(
				theme: model.readerTypography.theme,
				isCompactReader: isCompactReader,
			)
		)
		.navigationTitle(current.source)
		.navigationBarTitleDisplayMode(.inline)
		.navigationBarBackButtonHidden(true)
		.background {
			if isCompactReader {
				ReaderBackSwipeRecognizer(onBack: showFeedIfCompact)
			}
		}
		.safeAreaInset(edge: .bottom, spacing: 0) {
			ArticleReaderControlsBar(
				article: current,
				onShowReadingControls: showReadingSettings,
				onSaveConfirmation: { confirmation in
					withAnimation(ReaderMotion.animation(reduceMotion: reduceMotion)) {
						saveConfirmation = confirmation
					}
				},
			)
				.id(current.id)
		}
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				Menu("More", systemImage: "ellipsis.circle") {
					Button("Previous story", systemImage: "chevron.up") {
						navigateFromBoundary(.previous, from: current)
					}
					.disabled(model.canNavigateArticle(.previous) == false)
					Button("Next story", systemImage: "chevron.down") {
						navigateFromBoundary(.next, from: current)
					}
					.disabled(model.canNavigateArticle(.next) == false)
					Divider()
					Button(
						current.isStarred ? "Unstar" : "Star",
						systemImage: current.isStarred ? "star.fill" : "star",
					) {
						toggleStar(for: current)
					}
					.keyboardShortcut("s", modifiers: .command)
					.accessibilityIdentifier("article-reader-star")

					Divider()
					Button("Suggest more like this", systemImage: "plus.circle") {
						Task { await model.recordPreference(.moreLikeThis, for: current) }
					}

					Menu("Preferences", systemImage: "hand.thumbsup") {
						Button("Not interested", systemImage: "hand.thumbsdown") {
							Task { await model.recordPreference(.notInterested, for: current) }
						}
					}

					Divider()
					Button("Settings", systemImage: "gearshape") {
						model.isShowingSettings = true
					}
					.keyboardShortcut(",", modifiers: .command)
				}
				.accessibilityIdentifier("article-reader-more")
			}
		}
		.sheet(isPresented: $isShowingReadingSettings) {
			ReaderReadingSettingsView(settings: model.readerTypography)
		}
		.task(id: ArticleReaderModeResolutionIdentity(
			articleID: current.id,
			feedKey: current.feedKey,
			hasOriginalURL: current.safeOriginalURL != nil,
		)) {
			let restoredMode = ReaderMode.displayMode(
				stored: model.readerMode(for: current.feedKey),
				hasOriginalURL: current.safeOriginalURL != nil,
			)
			let isYouTubeVideo = YouTubeVideo(url: current.safeOriginalURL) != nil
			modeResolutionArticleID = current.id
			restoredModeForArticle = restoredMode
			selectedMode = restoredMode
			readerDocument = nil
			readerDocumentArticleID = nil
			readerViewArticleID = nil
			readerViewState = isYouTubeVideo || current.safeOriginalURL == nil ? .unavailable : .idle
		}
		.task(id: readerRequestID(for: current)) {
			isArticleBodyLaidOut = false
			resetReaderViewState(for: current)
			await loadReaderViewIfNeeded(for: current)
		}
		.task(id: "reader-prewarm-\(current.id)") {
			await prepareNextArticle(after: current)
		}
		.task(id: model.readerPreparation.contentIdentity(for: current)) {
			if let previousArticleID = activeArticleID,
				previousArticleID != current.id,
				let previousArticle = model.article(withId: previousArticleID) {
				persistReaderAnchors(for: previousArticle)
			}
			let activeKeys = Set([ReaderMode.feedContent, .readerView].map { readerContentKey(article: current, mode: $0) })
			readerLayouts = readerLayouts.filter { activeKeys.contains($0.key) }
			readerAnchors = readerAnchors.filter { activeKeys.contains($0.key) }
			activeArticleID = current.id
			boundaryNavigationInProgress = false
			boundaryPullController.cancel()
			saveConfirmation = nil
			scrollPosition = ScrollPosition()
			outerScrollOffset = 0
			articleBodyFrameMinY = nil
			articleBodyContentOrigin = nil
			let mode = readerMode(for: current)
			let key = readerContentKey(article: current, mode: mode)
			if let anchor = readerAnchors[key]
				?? model.readerPreparation.scrollAnchor(for: current, mode: mode.rawValue) {
				pendingReaderAnchor = ReaderAnchorRequest(key: key, anchor: anchor)
			} else {
				pendingReaderAnchor = nil
			}
			pendingRestoredDepth = model.articleScrollOffset(for: current.id)
			await model.recordExplicitOpen(for: current)
		}
		.onChange(of: ArticleReaderContentIdentity(articleID: current.id, mode: selectedMode), initial: true) { previous, currentIdentity in
			scrollPosition = ScrollPosition()
			pendingRestoredDepth = ArticleReaderContentIdentity.pendingRestoredDepth(
				previous: previous,
				current: currentIdentity,
				savedDepth: model.articleScrollOffset(for: currentIdentity.articleID),
				preserveSavedDepth: modeResolutionArticleID != currentIdentity.articleID
					|| restoredModeForArticle == currentIdentity.mode,
			)
		}
		.onPreferenceChange(ArticleBodyLayoutKey.self) { isLaidOut in
			isArticleBodyLaidOut = isLaidOut
		}
		.task(id: ReadingMonitorID(articleID: current.id, isActive: scenePhase == .active)) {
			guard scenePhase == .active else {
				return
			}
			await model.monitorActiveReading(for: current.id)
		}
		.onChange(of: selectedMode) { _, newMode in
			persistReaderAnchors(for: current)
			saveConfirmation = nil
			boundaryPullController.cancel()
			readerLayouts.removeValue(forKey: readerContentKey(article: current, mode: newMode))
			articleBodyFrameMinY = nil
			articleBodyContentOrigin = nil
			outerScrollOffset = 0
			let key = readerContentKey(article: current, mode: newMode)
			if let anchor = readerAnchors[key]
				?? model.readerPreparation.scrollAnchor(for: current, mode: newMode.rawValue) {
				pendingReaderAnchor = ReaderAnchorRequest(key: key, anchor: anchor)
			} else {
				pendingReaderAnchor = nil
			}
			if newMode == .readerView && YouTubeVideo(url: current.safeOriginalURL) != nil {
				return
			}
			model.setReaderMode(newMode, for: current)
			if newMode != .readerView {
				readerViewState = newMode == .feedContent ? .idle : .unavailable
			}
		}
		.modifier(ReaderSaveConfirmationModifier(confirmation: $saveConfirmation))
		.onDisappear {
			persistReaderAnchors(for: current)
			boundaryPullController.cancel()
			saveConfirmation = nil
		}
	}

	@ViewBuilder
	private func articleContent(for article: Recommendation) -> some View {
		switch readerMode(for: article) {
		case .feedContent:
			VStack(alignment: .leading, spacing: 18) {
				if let video = YouTubeVideo(url: article.safeOriginalURL) {
					YouTubePlayerView(
						video: video,
						playbackAllowed: scenePhase == .active,
						onOpenYouTube: openOriginal,
						onOpenLink: openYouTubeLink,
					)
				}
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
					preparedBody: model.readerPreparation.preparedBody(for: article),
					openedDestination: openInlineDestination,
					saveToReader: saveInlineDestination,
					onHTMLLayout: { layout in
						handleReaderLayout(layout, article: article, mode: .feedContent)
					},
					onBodyFrameChange: { minY in
						handleArticleBodyFrameChange(minY, article: article, mode: .feedContent)
					},
				)
				.id(ArticleBodyLayoutIdentity(articleID: article.id, content: article.html))
			}
		case .readerView:
			readerViewContent(for: article)
		case .website:
			EmptyView()
		}
	}

	@ViewBuilder
	private func readerViewContent(for article: Recommendation) -> some View {
		// A new title must never briefly display the previous story's document
		// while its request task is being replaced.
		let visibleState: ReaderViewLoadState = readerViewArticleID == article.id ? readerViewState : .loading
		switch visibleState {
		case .idle:
			Color.clear
				.frame(maxWidth: .infinity, minHeight: 1)
		case .loading:
			ReaderPreparationPlaceholder()
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
			if let readerDocument,
				ReaderViewDocumentOwnership.shouldApply(
					extractedArticleID: readerDocumentArticleID ?? "",
					visibleArticleID: article.id,
				) {
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
						preparedBody: PreparedReaderBody(
							sanitizedHTML: readerDocument.contentHTML,
							imageURLs: StructuredHTMLSanitizer.imageURLs(
								in: readerDocument.contentHTML,
								baseURL: article.safeOriginalURL,
							),
						),
						openedDestination: openInlineDestination,
						saveToReader: saveInlineDestination,
						onHTMLLayout: { layout in
							handleReaderLayout(layout, article: article, mode: .readerView)
						},
						onBodyFrameChange: { minY in
							handleArticleBodyFrameChange(minY, article: article, mode: .readerView)
						},
					)
					.id(ArticleBodyLayoutIdentity(articleID: article.id, content: readerDocument.contentHTML))
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
		readerContentKey(article: article, mode: selectedMode)
	}

	private func readerMode(for article: Recommendation) -> ReaderMode {
		if selectedMode == .readerView, YouTubeVideo(url: article.safeOriginalURL) != nil {
			return .feedContent
		}
		return selectedMode
	}

	private func selectMode(_ mode: ReaderMode) {
		let isYouTubeVideo = YouTubeVideo(url: currentArticle.safeOriginalURL) != nil
		guard mode == .feedContent
			|| (mode == .website && currentArticle.safeOriginalURL != nil)
			|| (mode == .readerView && isYouTubeVideo == false && currentArticle.safeOriginalURL != nil) else {
			return
		}
		selectedMode = mode
	}

	private func loadReaderViewIfNeeded(for article: Recommendation) async {
		guard selectedMode == .readerView, YouTubeVideo(url: article.safeOriginalURL) == nil else {
			return
		}
		guard article.safeOriginalURL != nil else {
			guard ReaderViewDocumentOwnership.shouldApply(
				extractedArticleID: article.id,
				visibleArticleID: currentArticle.id,
			) else {
				return
			}
			readerViewState = .unavailable
			readerDocumentArticleID = article.id
			readerViewArticleID = article.id
			return
		}
		if let cached = model.readerPreparation.cachedReaderDocument(for: article) {
			guard model.selectedArticleID == article.id, selectedMode == .readerView else { return }
			readerDocument = cached
			readerDocumentArticleID = article.id
			readerViewArticleID = article.id
			readerViewState = .loaded
			return
		}

		readerViewState = .loading
			do {
			let document = try await model.loadReaderView(for: article)
			try Task.checkCancellation()
			guard ReaderViewDocumentOwnership.shouldApply(
				extractedArticleID: article.id,
				visibleArticleID: currentArticle.id,
			) else {
				return
			}
			readerDocument = document
			readerDocumentArticleID = article.id
			readerViewArticleID = article.id
			readerViewState = .loaded
		} catch is CancellationError {
			return
		} catch {
			guard ReaderViewDocumentOwnership.shouldApply(
				extractedArticleID: article.id,
				visibleArticleID: currentArticle.id,
			) else {
				return
			}
			let hasFeedContent = article.html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
			readerViewState = hasFeedContent ? .fallback(error.localizedDescription) : .failed(error.localizedDescription)
			readerDocumentArticleID = article.id
			readerViewArticleID = article.id
		}
	}

	private func resetReaderViewState(for article: Recommendation) {
		readerViewArticleID = article.id
		readerDocumentArticleID = article.id
		readerDocument = model.readerPreparation.cachedReaderDocument(for: article)
		readerViewState = article.safeOriginalURL != nil
			&& YouTubeVideo(url: article.safeOriginalURL) == nil
			? (readerDocument == nil ? .idle : .loaded)
			: .unavailable
	}

	private func prepareNextArticle(after article: Recommendation) async {
		guard let next = model.articleTarget(for: .next, from: article) else {
			return
		}
		await model.readerPreparation.prepare(article: next)
	}

	private func readerContentKey(article: Recommendation, mode: ReaderMode) -> String {
		"\(model.readerPreparation.contentIdentity(for: article))|\(mode.rawValue)"
	}

	private func updateReaderAnchor(
		for article: Recommendation,
		mode: ReaderMode,
		geometry: ArticleScrollGeometry,
	) {
		let key = readerContentKey(article: article, mode: mode)
		guard pendingReaderAnchor?.key != key,
			let bodyFrameMinY = articleBodyFrameMinY,
			let layout = readerLayouts[key],
			let anchor = layout.anchor(at: Double(-bodyFrameMinY)) else {
			return
		}
		readerAnchors[key] = anchor
		_ = geometry
	}

	@discardableResult
	private func restorePendingReaderAnchor(
		for article: Recommendation,
		mode: ReaderMode,
		geometry: ArticleScrollGeometry?,
	) -> Bool {
		guard isScrollInteractionActive == false,
			let request = pendingReaderAnchor,
			request.key == readerContentKey(article: article, mode: mode),
			let layout = readerLayouts[request.key] else {
			return false
		}
		guard let target = layout.documentOffset(for: request.anchor) else {
			if layout.anchors.isEmpty == false {
				pendingReaderAnchor = nil
			}
			return false
		}
		guard let bodyFrameMinY = articleBodyFrameMinY else {
			return false
		}

		let currentOffset = geometry?.offset ?? outerScrollOffset
		let bodyOrigin = bodyFrameMinY + currentOffset
		scrollPosition.scrollTo(y: max(bodyOrigin + CGFloat(target), 0))
		pendingReaderAnchor = nil
		pendingRestoredDepth = nil
		return true
	}

	private func handleReaderLayout(
		_ layout: ReaderHTMLLayout,
		article: Recommendation,
		mode: ReaderMode,
	) {
		guard model.selectedArticleID == article.id else {
			return
		}
		let key = readerContentKey(article: article, mode: mode)
		let previousLayout = readerLayouts[key]
		guard previousLayout != layout else {
			return
		}
		readerLayouts[key] = layout

		if pendingReaderAnchor?.key == key {
			if layout.anchors.isEmpty {
				pendingReaderAnchor = nil
			} else {
				_ = restorePendingReaderAnchor(for: article, mode: mode, geometry: nil)
			}
			return
		}

		guard let previousLayout,
			previousLayout.anchors.isEmpty == false,
			layout.anchors.isEmpty == false,
			let anchor = readerAnchors[key]
				?? model.readerPreparation.scrollAnchor(for: article, mode: mode.rawValue) else {
			return
		}
		pendingReaderAnchor = ReaderAnchorRequest(key: key, anchor: anchor)
		_ = restorePendingReaderAnchor(for: article, mode: mode, geometry: nil)
	}

	private func handleArticleBodyFrameChange(
		_ minY: CGFloat,
		article: Recommendation,
		mode: ReaderMode,
	) {
		guard model.selectedArticleID == article.id else {
			return
		}
		let contentOrigin = minY + outerScrollOffset
		let didContentMove = articleBodyContentOrigin.map { abs($0 - contentOrigin) > 0.5 } ?? false
		articleBodyFrameMinY = minY
		articleBodyContentOrigin = contentOrigin
		let key = readerContentKey(article: article, mode: mode)
		if pendingReaderAnchor?.key != key {
			if didContentMove, isScrollInteractionActive == false, let previousAnchor = readerAnchors[key] {
				pendingReaderAnchor = ReaderAnchorRequest(key: key, anchor: previousAnchor)
			} else if let layout = readerLayouts[key], let anchor = layout.anchor(at: Double(-minY)) {
				readerAnchors[key] = anchor
			}
		}
		_ = restorePendingReaderAnchor(for: article, mode: mode, geometry: nil)
	}

	private func persistReaderAnchors(for article: Recommendation) {
		for mode in [ReaderMode.feedContent, .readerView] {
			let key = readerContentKey(article: article, mode: mode)
			guard let anchor = readerAnchors[key] else { continue }
			model.readerPreparation.cacheScrollAnchor(anchor, for: article, mode: mode.rawValue)
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
					preparedBody: model.readerPreparation.preparedBody(for: article),
					openedDestination: openInlineDestination,
					saveToReader: saveInlineDestination,
					onHTMLLayout: { layout in
						handleReaderLayout(layout, article: article, mode: .feedContent)
					},
					onBodyFrameChange: { minY in
						handleArticleBodyFrameChange(minY, article: article, mode: .feedContent)
					},
				)
				.id(ArticleBodyLayoutIdentity(articleID: article.id, content: article.html))
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func beginBoundaryPull(
		startedAt: ReaderBoundaryNavigationState,
		direction: ReaderBoundaryNavigationDirection,
		article: Recommendation,
	) {
		guard boundaryNavigationInProgress == false,
			boundaryPullController.state == nil,
			startedAt.isAtTop || startedAt.isAtBottom else {
			return
		}
		boundaryPullController.begin(
			articleID: article.id,
			direction: direction,
			preview: boundaryPreview(for: direction, from: article),
		)
	}

	private func updateBoundaryPull(
		startedAt: ReaderBoundaryNavigationState,
		direction: ReaderBoundaryNavigationDirection,
		translationX: CGFloat,
		translationY: CGFloat,
		article: Recommendation,
	) {
		guard boundaryPullController.articleID == article.id,
			boundaryPullController.direction == direction else {
			cancelBoundaryPull()
			return
		}
		let didArm = boundaryPullController.update(
			articleID: article.id,
			direction: direction,
			translationX: Double(translationX),
			translationY: Double(translationY),
			preview: boundaryPreview(for: direction, from: article),
		)
		if didArm {
			let feedback = UIImpactFeedbackGenerator(style: .soft)
			feedback.prepare()
			feedback.impactOccurred()
		}
		_ = startedAt
	}

	private func endBoundaryPull(
		startedAt: ReaderBoundaryNavigationState,
		direction: ReaderBoundaryNavigationDirection,
		translationX: CGFloat,
		translationY: CGFloat,
		article: Recommendation,
	) {
		guard boundaryPullController.articleID == article.id,
			boundaryPullController.direction == direction,
			let pullState = boundaryPullController.state,
			pullState.shouldCommit,
			let preview = boundaryPullController.preview else {
			cancelBoundaryPull()
			return
		}

		let currentPreview = boundaryPreview(for: direction, from: article)
		guard currentPreview.isReady,
			currentPreview.articleID == preview.articleID,
			currentPreview.articleID == model.articleTarget(for: direction, from: article)?.id else {
			cancelBoundaryPull()
			return
		}

		guard ReaderBoundaryNavigation.direction(
			startedAt: startedAt,
			translationX: Double(translationX),
			translationY: Double(translationY),
		) == direction else {
			cancelBoundaryPull()
			return
		}

		navigateFromBoundary(direction, from: article, expectedTargetID: currentPreview.articleID)
	}

	private func cancelBoundaryPull() {
		guard boundaryPullController.state != nil else { return }
		withAnimation(ReaderMotion.animation(reduceMotion: reduceMotion)) {
			boundaryPullController.cancel()
		}
	}

	private func boundaryPreview(
		for direction: ReaderBoundaryNavigationDirection,
		from article: Recommendation,
	) -> ReaderBoundaryPullPreview {
		let target = model.articleTarget(for: direction, from: article)
		return ReaderBoundaryPullPreview(
			direction: direction,
			articleID: target?.id,
			title: target?.title,
			isReady: target != nil,
		)
	}

	private func navigateFromBoundary(
		_ direction: ReaderBoundaryNavigationDirection,
		from current: Recommendation,
		expectedTargetID: String? = nil,
	) {
		guard boundaryNavigationInProgress == false else {
			return
		}
		guard let target = model.articleTarget(for: direction, from: current),
			expectedTargetID == nil || expectedTargetID == target.id else {
			return
		}
		persistReaderAnchors(for: current)

		withAnimation(ReaderMotion.animation(reduceMotion: reduceMotion)) {
			boundaryNavigationInProgress = true
			pendingRestoredDepth = model.articleScrollOffset(for: target.id)
			scrollPosition = ScrollPosition()
			_ = boundaryPullController.finish()
			_ = model.navigateArticle(direction, from: current)
		}
	}

	private func toggleStar(for article: Recommendation) {
		let animation = ReaderMotion.animation(reduceMotion: reduceMotion)
		let feedback = UIImpactFeedbackGenerator(style: .soft)
		feedback.prepare()
		feedback.impactOccurred()
		Task {
			await model.setStarred(
				article,
				starred: !article.isStarred,
				animation: reduceMotion ? nil : animation,
				offersUndo: true,
			)
		}
	}

	private func showReadingSettings() {
		isShowingReadingSettings = true
	}

	private func openOriginal() {
		guard let url = currentArticle.safeOriginalURL, let destination = OutboundDestination(url: url) else {
			return
		}
		Task { await model.recordOutboundClick(itemId: currentArticle.id, destinationHost: destination.host) }
		openURL(url)
	}

	private func openYouTubeLink(_ url: URL) {
		guard let destination = OutboundDestination(url: url), url.user == nil, url.password == nil else {
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
		let articleID = currentArticle.id
		let mode = selectedMode
		let outcome = try await model.saveToReader(destination)
		try Task.checkCancellation()
		guard model.selectedArticleID == articleID, selectedMode == mode else {
			return outcome
		}
		switch outcome {
		case .saved:
			withAnimation(ReaderMotion.animation(reduceMotion: reduceMotion)) {
				saveConfirmation = ReaderSaveConfirmation(message: "Saved to Reader", isSuccess: true)
			}
		case .alreadyInFlight:
			withAnimation(ReaderMotion.animation(reduceMotion: reduceMotion)) {
				saveConfirmation = ReaderSaveConfirmation(message: "Already saving this link…", isSuccess: false)
			}
		}
		return outcome
	}

	private var isCompactReader: Bool {
		horizontalSizeClass != .regular
	}

	@ViewBuilder
	private var compactBackBar: some View {
		if isCompactReader {
			HStack {
				Button(action: showFeedIfCompact) {
					Label(model.selectedCollection.title, systemImage: "chevron.backward")
				}
				.accessibilityIdentifier("article-back-to-feed")
				.accessibilityLabel(ReaderAccessibilityText.backToFeed(for: model.selectedCollection.title))
				Spacer(minLength: 0)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 10)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(.bar)
		}
	}

	private func showFeedIfCompact() {
		guard isCompactReader else {
			return
		}
		model.showFeedColumn()
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

private struct ReaderAnchorRequest: Equatable {
	let key: String
	let anchor: ReaderScrollAnchor
}

private struct ReaderPreparationPlaceholder: View {
	var body: some View {
		Text("Preparing Reader View")
			.font(.footnote)
			.foregroundStyle(.tertiary)
			.frame(maxWidth: .infinity, minHeight: 96)
			.accessibilityIdentifier("Preparing Reader View")
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
