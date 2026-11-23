import SwiftUI

struct ArticleListView: View {
	let collection: ReaderNavigationItem
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.readerCollectionIsTransitioning) private var isCollectionTransitioning
	@Environment(\.horizontalSizeClass) private var horizontalSizeClass
	@Environment(\.readerWindowHorizontalSizeClass) private var windowHorizontalSizeClass
	@Environment(\.dynamicTypeSize) private var dynamicTypeSize
	@Environment(\.scenePhase) private var scenePhase
	@State private var searchText = ""
	@State private var searchScope = ReaderSearchScope.collection
	@State private var searchPresentation = ReaderArticleSearchPresentation()
	@State private var searchAttempt = 0
	@State private var saveErrorMessage: String?
	@State private var isShowingSaveErrorMessage = false
	@State private var saveConfirmation: ReaderSaveConfirmation?
	@State private var actionFeedbackCount = 0
	@State private var presentationID = UUID()
	@State private var viewport = ReaderListViewportController()
	@State private var impressions = ReaderImpressionRecorder()
	@State private var isNearEnd = false
	@State private var paginationGate = ReaderAutomaticPaginationGate()
	@State private var paginationContext = ""
	@State private var paginationMovement = 0
	@State private var loadingState = ReaderCollectionLoadingState()
	@State private var reloadGeneration = 0
	@State private var initialLoadScope: String?
	@State private var updateBuffer = ReaderListUpdateBuffer()
	@State private var displayedMutationRevision: UInt64?
	@State private var isScrolling = false
	@State private var isNativeTransitioning = false
	@State private var isUserRefreshing = false
	@State private var readyContext: String?
	@State private var acceptedScrollRequest: UUID?
	@State private var isExplicitListTransitioning = false
	@State private var isLayoutReflowing = false
	@State private var layoutReflowToken: UUID?
	/// Cards shown in full ("N more") for this visit to the collection.
	@State private var expandedCardSections: Set<String> = []
	@State private var cardSectionsCache = FolderCardsSectionsCache()
	/// The section of the copy last tapped, for a story a folder shows twice:
	/// only that copy is highlighted, as on the web.
	@State private var selectedCopySectionID: String?
	@State private var selectedCopyArticleID: String?

	var body: some View {
		let allArticles = model.allArticles(for: collection)
		let searchRequest = currentSearchRequest
		let isSearchActive = searchRequest.isActive
		let searchPhase = searchPresentation.phase(for: searchRequest)
		let sourceArticles = isSearchActive
			? (searchPresentation.canDisplayResults(for: searchRequest) ? model.searchResults : [])
			: model.articles(for: collection)
		let articles = updateBuffer.displayedArticles(in: listContext, fallback: sourceArticles)
		// Folders and feeds draw sections (cards in Cards, a sectioned list in
		// Reeder). The stories drawn, each at its first copy and nothing behind
		// "N more", are what the viewport, scroll positions and paging see.
		let sections = usesSections ? folderCardSections(for: articles) : nil
		let drawnIDs = sections?.uniqueArticleIDs ?? articles.map(\.id)
		let rowMemoryContext = listContext
		let compactIDs = compactArticleIDs(articles, in: rowMemoryContext, isSearchActive: isSearchActive)
		let hasSavedPosition = model.listPositions.position(for: listContext)?.target(in: drawnIDs) != nil
		// Cards have no saved-position restore, so they are ready as soon as they appear.
		let isPositionReady = (usesCardsLook || hasSavedPosition == false || readyContext == listContext)
			&& isExplicitListTransitioning == false
		let holdsUpdates = isScrolling || isNativeTransitioning || isCollectionTransitioning
			|| isExplicitListTransitioning || isLayoutReflowing || isPositionReady == false
			|| isCoveredByReader
		let source = ReaderListSourceSnapshot(context: listContext, articles: sourceArticles, allArticles: allArticles,
			mutationRevision: model.articleListMutationRevision, mutationArticleID: model.articleListMutationArticleID)
		let listScope = ReaderListCollectionScope(
			accountID: model.session?.storageIdentity ?? "none",
			collectionID: collection.id,
		)
		let isLoading = model.isLoading(collection: collection) || model.isInitialLoadPending(for: collection)
		let isFilteredEmpty = model.isArticleFilterEmpty(for: collection)
		let presentation = loadingState.presentation(
			context: loadRequestKey,
			hasCachedCollection: model.hasCachedCollection(collection)
				&& (allArticles.isEmpty == false || (model.isInitialLoadPending(for: collection) == false
					&& model.hasFailedInitialLoad(for: collection) == false)),
			isLoading: isLoading
		)
		let preparesThumbnails = model.selectedNavigationID == collection.id
			&& (usesFrontPage || model.readerTypography.timelineDensity == .imageRich)
			&& model.readerTypography.remoteImagePolicy == .normal
		let thumbnailRequest = ReaderFeedThumbnailPrefetchRequest(
			scope: preparesThumbnails ? model.session?.storageIdentity : nil,
			articles: preparesThumbnails ? Array(articles.prefix(ReaderFeedThumbnailPolicy.firstScreenLimit)) : [],
		)
		let impressionState = impressionState(isSearchActive: isSearchActive)

		ZStack {
			if presentation == .loading {
				ReaderCollectionLoadingView(
					collectionTitle: collection.title,
					density: model.readerTypography.timelineDensity,
				)
					.transition(.opacity)
			} else if presentation == .unavailable {
				ContentUnavailableView {
					Label("Couldn’t load stories", systemImage: "exclamationmark.triangle")
				} description: {
					Text("Try loading this collection again.")
				} actions: {
					Button("Retry") { reloadGeneration &+= 1 }
						.accessibilityIdentifier("collection-retry")
				}
				.transition(.opacity)
			} else if searchPhase == .searching && articles.isEmpty {
				ProgressView("Searching saved stories")
					.accessibilityIdentifier("article-search-loading")
					.frame(maxWidth: .infinity, maxHeight: .infinity)
					.transition(.opacity)
			} else if searchPhase == .failed && articles.isEmpty {
				ContentUnavailableView {
					Label("Couldn’t search stories", systemImage: "magnifyingglass")
				} description: {
					Text("Try searching your saved stories again.")
				} actions: {
					Button("Retry") { searchAttempt &+= 1 }
						.accessibilityIdentifier("article-search-retry")
				}
			} else if articles.isEmpty {
				VStack {
					if isSearchActive {
						ContentUnavailableView.search(text: searchText)
							.accessibilityIdentifier("article-search-empty")
					} else if isFilteredEmpty {
						ContentUnavailableView(
							filteredEmptyTitle,
							systemImage: filteredEmptySystemImage,
							description: Text(filteredEmptyDescription),
						)
					} else {
						ContentUnavailableView(
							emptyTitle,
							systemImage: emptySystemImage,
							description: Text(emptyDescription),
						)
					}
					loadMoreControls(for: collection, isSearchActive: isSearchActive)
				}
				.frame(maxWidth: .infinity, maxHeight: .infinity)
				.transition(.opacity)
			} else if usesFolderCards, let cardSections = sections {
				folderCards(cardSections, articles: articles, isSearchActive: isSearchActive, holdsUpdates: holdsUpdates)
					.onChange(of: CardImpressionRows(sections: cardSections), initial: true) { _, rows in
						impressions.updateRows(rows.ids, readingLogRows: rows.rows)
					}
					.transition(.opacity)
			} else if usesFrontPage {
				// Front Page keeps its own pages; By Feed only orders them, and every
				// story's kicker already names its feed.
				frontPage(articles: articles, isSearchActive: isSearchActive, holdsUpdates: holdsUpdates)
					.task(id: thumbnailRequest) {
						guard let scope = thumbnailRequest.scope, thumbnailRequest.articles.isEmpty == false else { return }
						await ReaderFeedThumbnailStore.shared.prefetch(articles: thumbnailRequest.articles, scope: scope)
					}
					.onChange(of: articles.map(\.id), initial: true) { _, ids in impressions.updateRows(ids) }
					.transition(.opacity)
			} else {
				ScrollViewReader { proxy in
					List {
						if let sections {
							// Labels and "N more" are plain rows without an anchor: the
							// viewport, impressions and selection only see story rows.
							ForEach(sections.sections) { section in
								sectionRows(section, in: sections, presentedArticles: articles, compactIDs: compactIDs)
							}
						} else {
							ForEach(articles) { article in
								articleRow(article, presentedArticles: articles, compactIDs: compactIDs,
									showsFeedName: collection.kind != .feed || isSearchActive)
							}
						}
						Text(model.collectionStatusText(for: collection))
							.font(.footnote)
							.foregroundStyle(.pigeonSecondary)
							.frame(maxWidth: .infinity, alignment: .center)
							.listRowSeparator(.hidden)
							.accessibilityLabel("Collection status: \(model.collectionStatusText(for: collection))")
						loadMoreControls(for: collection, isSearchActive: isSearchActive)
					}
					.listStyle(.plain)
					// Section labels and "N more" are short rows.
					.environment(\.defaultMinListRowHeight, 1)
					.onChange(of: drawnUnreadIDs(sections: sections, articles: articles), initial: true) {
						// Search results are not a list to come back to.
						guard isSearchActive == false else { return }
						model.fullRowMemory.noteDrawn(sections?.renderedArticles ?? articles, in: rowMemoryContext)
					}
					.onChange(of: ReaderListReadingLogTags(sections: sections, articles: articles,
						isCompact: { compactIDs.contains($0.id) }), initial: true) { _, tags in
						impressions.setReadingLogTags(rows: tags.rows, sections: tags.sections)
					}
					.task(id: thumbnailRequest) {
						guard let scope = thumbnailRequest.scope, thumbnailRequest.articles.isEmpty == false else { return }
						await ReaderFeedThumbnailStore.shared.prefetch(articles: thumbnailRequest.articles, scope: scope)
					}
					.animation(ReaderMotion.contentArrival(reduceMotion: reduceMotion)) { content in
						content.opacity(isPositionReady ? (isLayoutReflowing ? 0.92 : 1) : 0)
					}
					.allowsHitTesting(isPositionReady && isLayoutReflowing == false)
					.accessibilityHidden(isPositionReady == false || isLayoutReflowing)
					.onScrollPhaseChange { _, phase in
						isScrolling = phase != .idle
					}
					.task(id: listContext) {
						guard model.selectedNavigationID == collection.id else { return }
						let context = listContext
						// The explicit-control callback normally commits in the outer
						// onChange. Repeating it here closes the small SwiftUI scheduling
						// window before activation can read the target position.
						viewport.commitContextChange(to: context, scope: listScope)
						let target = viewport.activate(
							context: listContext, articleIDs: drawnIDs, store: model.listPositions,
							scope: listScope,
							onNearEnd: { if isNearEnd != $0 { isNearEnd = $0 } },
							onUserScroll: {
								if paginationGate.userDidScroll() { paginationMovement &+= 1 }
							},
							onRestorationComplete: {
								guard model.selectedNavigationID == collection.id, listContext == context else { return }
								readyContext = context
								isExplicitListTransitioning = false
							},
							onNavigationActivity: { if isNativeTransitioning != $0 { isNativeTransitioning = $0 } }
						)
						if let target {
							await Task.yield()
							guard Task.isCancelled == false else { return }
							proxy.scrollTo(target, anchor: .top)
							viewport.completeCoarseRestore()
						}
					}
					.task(id: acceptedScrollRequest) {
						guard let request = acceptedScrollRequest, let firstID = drawnIDs.first else { return }
						let context = listContext
						await Task.yield()
						guard Task.isCancelled == false, acceptedScrollRequest == request,
							listContext == context, model.selectedNavigationID == collection.id else { return }
						withAnimation(reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false)) {
							proxy.scrollTo(firstID, anchor: .top)
						}
						acceptedScrollRequest = nil
					}
					.overlay(alignment: .top) {
						if updateBuffer.needsAcceptance, holdsUpdates == false {
							ReaderNewStoriesButton(count: updateBuffer.newStoryCount, action: showUpdatedStories)
						}
					}
					.onChange(of: drawnIDs) { _, ids in viewport.updateArticleIDs(ids) }
					.onDisappear {
						viewport.deactivate()
						readyContext = nil
						isScrolling = false
						isExplicitListTransitioning = false
						isLayoutReflowing = false
						layoutReflowToken = nil
					}
				}
				.transition(.opacity)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.overlay(alignment: .top) {
			if model.markingAllReadCollectionID == collection.id {
				searchStatus {
					ProgressView().controlSize(.small).accessibilityHidden(true)
					Text("Marking all as read…")
				}
				.accessibilityElement(children: .combine)
				.accessibilityIdentifier("article-list-mark-read-progress")
				.allowsHitTesting(false)
			}
		}
		.overlay(alignment: .bottom) {
			if articles.isEmpty == false && isSearchActive {
				if searchPhase == .searching {
					searchStatus {
						ProgressView().controlSize(.small)
						Text("Updating results")
					}
					.accessibilityIdentifier("article-search-updating")
				} else if searchPhase == .failed {
					searchStatus {
						Text("Couldn’t update results")
						Button("Retry") { searchAttempt &+= 1 }
					}
				}
			}
		}
		.onChange(of: model.selectedArticleID) { _, id in
			// Next, previous or a deep link: highlight the story's first copy.
			if id != selectedCopyArticleID { selectedCopySectionID = nil }
		}
		.onChange(of: model.markingAllReadCollectionID) { _, collectionID in
			if collectionID == collection.id {
				AccessibilityNotification.Announcement("Marking all as read").post()
			}
		}
		.animation(ReaderMotion.contentArrival(reduceMotion: reduceMotion), value: presentation)
		.onChange(of: source, initial: true) { _, source in
			let isManualMutation = displayedMutationRevision != nil && displayedMutationRevision != source.mutationRevision
			displayedMutationRevision = source.mutationRevision
			// Undo and manual read/star actions are direct intent, even when they
			// restore a row ahead of the current viewport.
			updateBuffer.receive(source.articles, context: source.context, holding: holdsUpdates,
				explicit: isUserRefreshing || isSearchActive, knownArticles: source.allArticles,
				manuallyChangedArticleID: isManualMutation ? source.mutationArticleID : nil)
		}
		.onChange(of: holdsUpdates) { _, holding in
			if holding == false, usesListSections, updateBuffer.hasPendingUpdate,
				updateBuffer.needsAcceptance == false {
				// A page that waited for the gesture lands now (see `loadOlderStories`).
				viewport.prepareForLayoutReflow()
			}
			updateBuffer.receive(source.articles, context: source.context, holding: holding,
				explicit: isUserRefreshing || isSearchActive, knownArticles: source.allArticles)
		}
		.onChange(of: listContext) { _, context in
			viewport.commitContextChange(to: context, scope: listScope)
			if isExplicitListTransitioning && (articles.isEmpty || usesCardsLook) {
				readyContext = context
				isExplicitListTransitioning = false
			}
		}
		.onChange(of: dynamicTypeSize) {
			prepareForDynamicTypeReflow()
		}
		// Reading log: which stories this list showed. No view state changes here.
		.onChange(of: impressionState, initial: true) { _, state in
			impressions.apply(state, viewport: usesCardsLook ? nil : viewport, model: model)
		}
		.onAppear {
			impressions.apply(impressionState, viewport: usesCardsLook ? nil : viewport, model: model)
		}
		.onDisappear {
			impressions.endSession()
		}
		.allowsHitTesting(model.selectedNavigationID == collection.id)
		.accessibilityHidden(model.selectedNavigationID != collection.id)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("collection-pane-\(collection.id)")
		.navigationTitle(navigationTitle)
		.toolbarTitleDisplayMode(usesCardsLook ? .inline : .automatic)
		.searchable(text: $searchText, prompt: "Titles, authors, feeds, and text")
		.searchScopes($searchScope) {
			ForEach(ReaderSearchScope.allCases) { scope in
				Text(scope == .collection ? collection.title : scope.title).tag(scope)
			}
		}
		.refreshable {
			let context = listContext
			isUserRefreshing = true
			defer { isUserRefreshing = false }
			await model.refresh(collection: collection)
			if Task.isCancelled == false, listContext == context {
				let request = currentSearchRequest
				let current = request.isActive
					? (searchPresentation.canDisplayResults(for: request) ? model.searchResults : [])
					: model.articles(for: collection)
				updateBuffer.receive(current, context: context, holding: false, explicit: true)
			}
		}
		.task(id: loadRequestKey) {
			await loadCollection()
		}
		.task(id: searchRequest) {
			guard model.selectedNavigationID == collection.id else { return }
			guard searchRequest.isActive else {
				searchPresentation = ReaderArticleSearchPresentation()
				model.clearArticleSearch()
				return
			}
			try? await Task.sleep(for: .milliseconds(250))
			guard Task.isCancelled == false, model.selectedNavigationID == collection.id,
				searchRequest == currentSearchRequest else { return }
			let outcome = await model.searchArticles(query: searchRequest.query, scope: searchRequest.scope, in: collection)
			guard Task.isCancelled == false, model.selectedNavigationID == collection.id else { return }
			searchPresentation.finish(searchRequest, outcome: outcome, current: currentSearchRequest)
		}
		.task(id: AutomaticPageRequest(context: listContext, token: model.paginationToken(for: collection), nearEnd: isNearEnd || (articles.isEmpty && allArticles.isEmpty == false), ready: isLoading == false && updateBuffer.hasPendingUpdate == false, movement: paginationMovement)) {
			guard model.selectedNavigationID == collection.id,
				updateBuffer.hasPendingUpdate == false,
				isSearchActive == false, isNearEnd || (articles.isEmpty && allArticles.isEmpty == false),
				model.isLoading(collection: collection) == false,
				let token = model.paginationToken(for: collection) else { return }
			if paginationContext != listContext {
				paginationContext = listContext
				paginationGate = ReaderAutomaticPaginationGate()
			}
			guard paginationGate.claim(
				token,
				hasError: model.loadMoreError(for: collection) != nil,
				budget: sectionsHideStories ? 1 : ReaderAutomaticPaginationGate.defaultBudget,
			) else { return }
			let requestContext = listContext
			await loadOlderStories()
			if Task.isCancelled, paginationContext == requestContext { paginationGate.cancelClaim(token) }
		}
		.toolbar {
			if model.selectedNavigationID == collection.id {
				ArticleListToolbar(
					collection: collection,
					onListContextWillChange: prepareForListContextChange,
					onTimelineDensityWillChange: prepareForTimelineDensityChange,
				)
			}
		}
		.modifier(ReaderSaveConfirmationModifier(confirmation: $saveConfirmation))
		.sensoryFeedback(.selection, trigger: actionFeedbackCount)
		.onChange(of: collection.id) {
			resetSavePresentation()
		}
		.onDisappear(perform: resetSavePresentation)
		.alert("Couldn’t Save Link", isPresented: $isShowingSaveErrorMessage) {
		} message: {
			Text(saveErrorMessage ?? "")
		}
	}

	/// In a compact window the open story covers this list, so updates wait for
	/// the reader to close. An iPad split view keeps the list beside the story;
	/// its list column reports a compact size class of its own, which is why
	/// this asks the window.
	private var isCoveredByReader: Bool {
		(windowHorizontalSizeClass ?? horizontalSizeClass) == .compact && model.preferredCompactColumn == .detail
	}

	/// Cards is a look on iPhone and iPad. On iPad it fills the window (see
	/// `ReaderCompactArticlePresentation.navigationSizeClass`).
	private var usesCardsLook: Bool {
		model.readerTypography.look == .cards
	}

	/// Folders and feeds in Cards are cards.
	private var usesFolderCards: Bool {
		usesCardsLook && (collection.kind == .folder || collection.kind == .feed)
	}

	/// Smart views in Cards are the Front Page.
	private var usesFrontPage: Bool {
		usesCardsLook && usesFolderCards == false
	}

	/// Folders and feeds in Reeder: the cards' sections as a hairline list.
	private var usesListSections: Bool {
		// Search results (possibly library-wide) are one flat list that names
		// each story's feed.
		usesCardsLook == false && (collection.kind == .folder || collection.kind == .feed)
			&& currentSearchRequest.isActive == false
	}

	private var usesSections: Bool {
		usesFolderCards || usesListSections
	}

	/// Folders (and feeds in Cards) keep stories behind "N more", so a page
	/// loaded automatically may add nothing visible: fetch one per scroll. A
	/// Reeder feed's day sections hide nothing.
	private var sectionsHideStories: Bool {
		usesFolderCards || (usesListSections && collection.kind == .folder)
	}

	/// A section's label, its stories and its "N more". A story the folder
	/// shows twice gets its plain id and scroll anchor at its first copy only.
	@ViewBuilder
	private func sectionRows(_ section: FolderSections.Section, in sections: FolderSections,
		presentedArticles articles: [Recommendation], compactIDs: Set<String>) -> some View {
		ArticleSectionLabel(
			section: section,
			remoteImagePolicy: model.readerTypography.remoteImagePolicy,
			openFeed: openFeedAction(for: section),
		)
		.listRowInsets(EdgeInsets(top: section.id == sections.sections.first?.id ? 8 : 22, leading: 16, bottom: 4, trailing: 16))
		.listRowSeparator(.hidden)
		.listRowBackground(Color.clear)
		ForEach(Array(section.articles.enumerated()), id: \.element.id) { index, article in
			articleRow(
				article,
				presentedArticles: articles,
				compactIDs: compactIDs,
				// A feed's own sections and a feed section are all one feed.
				showsFeedName: collection.kind != .feed && section.kind != .feed,
				in: sections,
				section: section,
				copyIndex: sections.copyIndex(of: index, inSection: section.id),
			)
		}
		if section.hiddenCount > 0 {
			ArticleSectionMoreButton(section: section) {
				withAnimation(ReaderMotion.animation(reduceMotion: reduceMotion)) {
					_ = expandedCardSections.insert(section.id)
				}
			}
			.listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 6, trailing: 16))
			.listRowSeparator(.hidden, edges: .bottom)
			.listRowBackground(Color.clear)
		}
	}

	/// `sections` and `section` are set in a sectioned list; `copyIndex` is the
	/// story's place among every drawn copy, for above and below.
	private func articleRow(
		_ article: Recommendation,
		presentedArticles articles: [Recommendation],
		compactIDs: Set<String>,
		showsFeedName: Bool,
		in sections: FolderSections? = nil,
		section: FolderSections.Section? = nil,
		copyIndex: Int? = nil,
	) -> some View {
		let isFirstCopy = section.map { sections?.firstSectionIDs[article.id] == $0.id } ?? true
		let isHighlighted = model.selectedArticleID == article.id
			&& highlightedSectionID(for: article.id, in: sections) == section?.id
		return ArticleRowView(
			article: article,
			density: model.readerTypography.timelineDensity,
			remoteImagePolicy: model.readerTypography.remoteImagePolicy,
			thumbnailStore: ReaderFeedThumbnailStore.shared,
			thumbnailScope: model.session?.storageIdentity,
			imageProxySession: model.session,
			showsFeedName: showsFeedName,
			isCompact: compactIDs.contains(article.id),
			select: {
				selectedCopySectionID = section?.id
				selectedCopyArticleID = article.id
				impressions.rowChosen(article.id)
				// Next and previous follow the sections, not the saved sort.
				model.retainPresentedArticles(articles, in: collection, order: sections?.uniqueArticleIDs)
				model.select(article: article)
			},
		)
		.alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
		.id(isFirstCopy ? article.id : "\(section?.id ?? "")|\(article.id)")
		.background {
			if isFirstCopy {
				ReaderListRowAnchor(articleID: article.id, controller: viewport)
			}
		}
		.listRowBackground(isHighlighted ? Color.accentColor.opacity(0.1) : .clear)
		.swipeActions(edge: .leading, allowsFullSwipe: true) {
			readButton(for: article)
		}
		.swipeActions(edge: .trailing, allowsFullSwipe: true) {
			readItLaterButton(for: article)
			starButton(for: article)
		}
		.contextMenu {
			readButton(for: article)
			starButton(for: article)
			Divider()
			// Above and below mean the list as drawn, from this copy.
			markAboveButton(for: article, order: sections?.renderedCopies, at: copyIndex)
			markBelowButton(for: article, order: sections?.renderedCopies, at: copyIndex)
		}
	}

	/// A feed section's label opens that feed as the list beside the library.
	private func openFeedAction(for section: FolderSections.Section) -> (() -> Void)? {
		guard let feed = section.feed, let item = navigationItem(for: feed) else { return nil }
		return { model.select(item: item) }
	}

	/// The section whose copy of the story is highlighted: the one tapped, or
	/// the first copy when the story was chosen another way (next, previous).
	private func highlightedSectionID(for articleID: String, in sections: FolderSections?) -> String? {
		guard let sections else { return nil }
		if let selectedCopySectionID,
			sections.sections.contains(where: { $0.id == selectedCopySectionID && $0.articles.contains { $0.id == articleID } }) {
			return selectedCopySectionID
		}
		return sections.firstSectionIDs[articleID]
	}

	/// Stories drawn as one compact line: read before this list showed them in
	/// full. Never the open story, nor in search results (web parity).
	private func compactArticleIDs(_ articles: [Recommendation], in context: String,
		isSearchActive: Bool) -> Set<String> {
		guard usesCardsLook == false, isSearchActive == false else { return [] }
		let selectedID = model.selectedArticleID
		return Set(articles.lazy
			.filter { $0.id != selectedID && model.fullRowMemory.isCompact($0, in: context) }
			.map(\.id))
	}

	/// The unread stories drawn: when it changes, the full-row memory learns them.
	private func drawnUnreadIDs(sections: FolderSections?, articles: [Recommendation]) -> [String] {
		(sections?.renderedArticles ?? articles).compactMap { $0.isRead ? nil : $0.id }
	}

	private func frontPage(articles: [Recommendation], isSearchActive: Bool, holdsUpdates: Bool) -> some View {
		ScrollViewReader { proxy in
			FrontPageView(
				title: collection.title,
				unreadCount: model.navigation.item(withID: collection.id)?.unreadCount ?? collection.unreadCount,
				articles: articles,
				selectedArticleID: model.selectedArticleID,
				remoteImagePolicy: model.readerTypography.remoteImagePolicy,
				thumbnailScope: model.session?.storageIdentity,
				select: { article in
					impressions.rowChosen(article.id)
					model.retainPresentedArticles(articles, in: collection)
					model.select(article: article)
				},
				onNearEndChange: { if isNearEnd != $0 { isNearEnd = $0 } },
				onUserScroll: {
					if paginationGate.userDidScroll() { paginationMovement &+= 1 }
				},
				onScrollingChange: { if isScrolling != $0 { isScrolling = $0 } },
				onStoryVisibilityChange: { impressions.setRowVisible($0, $1) },
			) { article in
				readButton(for: article)
				starButton(for: article)
				Divider()
				markAboveButton(for: article)
				markBelowButton(for: article)
			} footer: {
				Text(model.collectionStatusText(for: collection))
					.font(.footnote)
					.foregroundStyle(.pigeonSecondary)
					.accessibilityLabel("Collection status: \(model.collectionStatusText(for: collection))")
				loadMoreControls(for: collection, isSearchActive: isSearchActive)
			}
			.task(id: acceptedScrollRequest) {
				guard let request = acceptedScrollRequest else { return }
				await Task.yield()
				guard Task.isCancelled == false, acceptedScrollRequest == request else { return }
				withAnimation(reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false)) {
					proxy.scrollTo(FrontPageLayout.topAnchorID, anchor: .top)
				}
				acceptedScrollRequest = nil
			}
			.overlay(alignment: .top) {
				if updateBuffer.needsAcceptance, holdsUpdates == false {
					ReaderNewStoriesButton(count: updateBuffer.newStoryCount, action: showUpdatedStories)
				}
			}
			.onDisappear {
				isScrolling = false
				isNearEnd = false
			}
		}
	}

	/// The order the page draws stories in when it is not the sort: the
	/// cards', each story at its first appearance.
	private var presentedOrder: [String]? {
		usesSections ? cardSectionsCache.current?.uniqueArticleIDs : nil
	}

	private var presentationName: String {
		usesFolderCards ? "cards" : usesFrontPage ? "front-page" : usesListSections ? "reeder" : "classic"
	}

	/// Built once per change of the stories, expansions or day (see
	/// `FolderCardsSectionsCache`), not on every body pass.
	private func folderCardSections(for articles: [Recommendation]) -> FolderSections {
		let isFolder = collection.kind == .folder
		let now = Date.now
		let key = FolderCardsSectionsCache.Key(
			articles: articles,
			expanded: expandedCardSections,
			feeds: isFolder ? model.articleFeedDirectory : .empty,
			isFolder: isFolder,
			collapsesDays: usesFolderCards,
			// The model's day moves on at midnight and on returning to the app,
			// which re-renders this page with that day's Today.
			day: model.localDayStart,
		)
		return cardSectionsCache.sections(for: key) {
			isFolder
				? FolderSections.make(articles: articles, feeds: key.feeds, now: now, expanded: key.expanded)
				: FeedDaySections.make(articles: articles, now: now, expanded: key.expanded,
					limit: key.collapsesDays ? FeedDaySections.dayLimit : .max)
		}
	}

	/// The feed's own list, preferring its row in this folder.
	private func navigationItem(for feed: ArticleFeedDirectory.Feed) -> ReaderNavigationItem? {
		let rows = model.navigation.items.filter { $0.kind == .feed && $0.streamID == feed.id }
		return rows.first { $0.parentID == collection.id } ?? rows.first
	}

	private func folderCards(
		_ sections: FolderSections,
		articles: [Recommendation],
		isSearchActive: Bool,
		holdsUpdates: Bool,
	) -> some View {
		ScrollViewReader { proxy in
			FolderCardsView(
				sections: sections,
				feeds: model.articleFeedDirectory,
				showsFeedNames: collection.kind == .folder,
				colorIndex: model.cardColorIndex(for: collection),
				selectedArticleID: model.selectedArticleID,
				remoteImagePolicy: model.readerTypography.remoteImagePolicy,
				select: { article in
					impressions.rowChosen(article.id)
					// Next and previous follow the cards, not the saved sort.
					model.retainPresentedArticles(articles, in: collection, order: sections.uniqueArticleIDs)
					model.select(article: article)
				},
				onExpand: { sectionID in
					withAnimation(ReaderMotion.animation(reduceMotion: reduceMotion)) {
						_ = expandedCardSections.insert(sectionID)
					}
				},
				canOpenFeed: { navigationItem(for: $0) != nil },
				onOpenFeed: { feed in
					guard let item = navigationItem(for: feed) else { return }
					// Pushed above the folder, which stays as it was left.
					if collection.kind == .folder {
						model.openFeed(item, fromFolder: collection)
					} else {
						model.select(item: item)
					}
				},
				onNearEndChange: { if isNearEnd != $0 { isNearEnd = $0 } },
				onUserScroll: {
					if paginationGate.userDidScroll() { paginationMovement &+= 1 }
				},
				onScrollingChange: { if isScrolling != $0 { isScrolling = $0 } },
				onStoryVisibilityChange: { impressions.setRowVisible($0, $1, copy: $2) },
			) { article, copyIndex in
				// Above and below mean the cards as drawn from the copy the menu
				// was opened on, not the collection's sort.
				readButton(for: article)
				starButton(for: article)
				Divider()
				markAboveButton(for: article, order: sections.renderedCopies, at: copyIndex)
				markBelowButton(for: article, order: sections.renderedCopies, at: copyIndex)
			} footer: {
				Text(model.collectionStatusText(for: collection))
					.font(.footnote)
					.foregroundStyle(.pigeonSecondary)
					.accessibilityLabel("Collection status: \(model.collectionStatusText(for: collection))")
				loadMoreControls(for: collection, isSearchActive: isSearchActive)
			}
			.task(id: acceptedScrollRequest) {
				guard let request = acceptedScrollRequest else { return }
				await Task.yield()
				guard Task.isCancelled == false, acceptedScrollRequest == request else { return }
				withAnimation(reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false)) {
					proxy.scrollTo(FolderCardsLayout.topAnchorID, anchor: .top)
				}
				acceptedScrollRequest = nil
			}
			.overlay(alignment: .top) {
				if updateBuffer.needsAcceptance, holdsUpdates == false {
					ReaderNewStoriesButton(count: updateBuffer.newStoryCount, action: showUpdatedStories)
				}
			}
			.onDisappear {
				isScrolling = false
				isNearEnd = false
			}
		}
	}

	/// One impression session per continuous showing of one list context. The
	/// list is off screen while another collection or Home is selected, and
	/// paused while the scene is inactive or the reader covers it on iPhone.
	private func impressionState(isSearchActive: Bool) -> ReaderImpressionRecorder.ListState {
		let isOnScreen = model.selectedNavigationID == collection.id && model.preferredCompactColumn != .sidebar
		return ReaderImpressionRecorder.ListState(
			sessionKey: isOnScreen
				? "\(listContext)|\(presentationName)|\(model.readingLogSessionEpoch)"
				: nil,
			list: ReadingLogList.list(for: collection, search: isSearchActive ? searchScope : nil),
			isPaused: scenePhase != .active || ReaderCompactArticlePresentation.isActive(
				horizontalSizeClass: windowHorizontalSizeClass ?? horizontalSizeClass,
				preferredColumn: model.preferredCompactColumn,
				hasSelectedArticle: model.selectedArticleID != nil,
			),
		)
	}

	private var loadRequestKey: String {
		"\(model.session?.storageIdentity ?? "none")|\(collection.id)|\(model.libraryGeneration)|\(reloadGeneration)"
	}

	private var navigationTitle: String {
		guard collection.smartSection?.usesDayWindow == true else { return collection.title }
		let unreadCount = model.navigation.item(withID: collection.id)?.unreadCount ?? collection.unreadCount
		return "\(collection.title) (\(unreadCount.formatted()))"
	}

	private var currentSearchRequest: ReaderArticleSearchRequest {
		ReaderArticleSearchRequest(
			accountID: model.session?.storageIdentity,
			collectionID: collection.id,
			scope: searchScope,
			query: searchText.trimmingCharacters(in: .whitespacesAndNewlines),
			attempt: searchAttempt,
		)
	}

	private func searchStatus<Content: View>(@ViewBuilder content: () -> Content) -> some View {
		HStack(spacing: 8, content: content)
			.font(.footnote)
			.padding(.horizontal, 16)
			.padding(.vertical, 10)
			.background(.regularMaterial, in: Capsule())
			.padding()
	}

	private func showUpdatedStories() {
		updateBuffer.acceptPending()
		model.listPositions.removePosition(for: listContext)
		readyContext = listContext
		isNearEnd = false
		acceptedScrollRequest = UUID()
	}

	private func prepareForListContextChange() {
		guard model.selectedNavigationID == collection.id else { return }
		viewport.prepareForContextChange()
		isExplicitListTransitioning = true
	}

	private func prepareForTimelineDensityChange() {
		let token = UUID()
		layoutReflowToken = token
		isLayoutReflowing = true
		viewport.prepareForLayoutReflow {
			guard layoutReflowToken == token else { return }
			layoutReflowToken = nil
			isLayoutReflowing = false
		}
	}

	private func prepareForDynamicTypeReflow() {
		let token = UUID()
		layoutReflowToken = token
		isLayoutReflowing = true
		viewport.prepareForLayoutReflow(captureCurrentPosition: false) {
			guard layoutReflowToken == token else { return }
			layoutReflowToken = nil
			isLayoutReflowing = false
		}
	}

	private func loadCollection() async {
		guard model.selectedNavigationID == collection.id else { return }
		let requestKey = loadRequestKey
		let requestID = loadingState.begin(context: requestKey)
		let scope = "\(model.session?.storageIdentity ?? "none")|\(collection.id)"
		// This also runs when a sync changes the library under the list on
		// screen. Only the first load of a list starts from an empty search; a
		// later one must not wipe a search the reader is in the middle of.
		if initialLoadScope != scope {
			searchText = ""
			searchPresentation = ReaderArticleSearchPresentation()
			model.clearArticleSearch()
		}
		let context = listContext
		let initialLoadID = initialLoadScope == scope
			? nil
			: updateBuffer.beginInitialLoad(context: context)
		defer {
			if let initialLoadID {
				updateBuffer.finishInitialLoad(context: context, loadID: initialLoadID)
			}
		}
		if reloadGeneration == 0 {
			await model.loadForDisplay(collection: collection)
		} else {
			await model.load(collection: collection, force: true)
		}
		guard Task.isCancelled == false,
			model.selectedNavigationID == collection.id,
			listContext == context,
			loadRequestKey == requestKey else { return }
		if initialLoadID != nil {
			let request = currentSearchRequest
			let current = request.isActive
				? (searchPresentation.canDisplayResults(for: request) ? model.searchResults : [])
				: model.articles(for: collection)
			updateBuffer.receive(current, context: context, holding: false, explicit: true)
		}
		let initialLoadSucceeded = model.hasCachedCollection(collection)
			&& model.hasFailedInitialLoad(for: collection) == false
			&& model.isInitialLoadPending(for: collection) == false
		if initialLoadID != nil, initialLoadSucceeded {
			initialLoadScope = scope
		}
		loadingState.finish(requestID: requestID)
	}

	private func loadOlderStories() async {
		let context = listContext
		await model.loadMore(collection: collection)
		guard Task.isCancelled == false, context == listContext,
			model.selectedNavigationID == collection.id else { return }
		// Oldest-first lists prepend older pages. This is expected paging, so it
		// waits for a gesture to end without offering them as "new stories".
		let holding = isScrolling || isNativeTransitioning || isCollectionTransitioning
			|| isCoveredByReader
		// In Reeder's sections an older page also adds rows to sections above
		// the viewport; keep the story being read where it is.
		if holding == false, usesListSections { viewport.prepareForLayoutReflow() }
		updateBuffer.receive(model.articles(for: collection), context: context, holding: holding,
			acceptsReordering: true)
	}

	private var listContext: String {
		"\(model.session?.storageIdentity ?? "none")|\(collection.id)|\(model.articleFilter(for: collection).rawValue)|\(model.sortOrder(for: collection).rawValue)|\(searchScope.rawValue)|\(searchText.trimmingCharacters(in: .whitespacesAndNewlines))"
	}

	@ViewBuilder
	private func loadMoreControls(for collection: ReaderNavigationItem, isSearchActive: Bool) -> some View {
		if isSearchActive == false {
			if let error = model.loadMoreError(for: collection) {
				Text("Could not load more articles: \(error)")
					.font(.footnote)
					.foregroundStyle(.pigeonDanger)
					.frame(maxWidth: .infinity, alignment: .center)
					.listRowSeparator(.hidden)
			}
			if model.canLoadMore(collection: collection) {
				Button {
					Task { await loadOlderStories() }
				} label: {
					if model.isLoadingMore(collection: collection) {
						HStack {
							ProgressView()
							Text("Loading more articles…")
						}
					} else {
						Label("Load More Articles", systemImage: "arrow.down.circle")
					}
				}
				.frame(maxWidth: .infinity)
				.disabled(model.isLoading(collection: collection) || model.isLoadingMore(collection: collection) || updateBuffer.hasPendingUpdate)
				.listRowSeparator(.hidden)
				.accessibilityHint("Loads older articles in this collection")
			}
		}
	}

	private var emptyTitle: String {
		switch collection.smartSection {
		case .starred: "No starred stories"
		case .today: "Nothing from today"
		case .lastSevenDays: "Nothing from the last 7 days"
		case .forYou: "No recommendations yet"
		case .unread: "You are all caught up"
		case .saved: "Nothing saved yet"
		case nil: "No stories yet"
		}
	}

	private var emptySystemImage: String {
		switch collection.smartSection {
		case .starred: "star"
		case .today: "calendar"
		case .lastSevenDays: "calendar.badge.clock"
		case .forYou: "sparkles"
		default: "checkmark.circle"
		}
	}

	private var emptyDescription: String {
		switch collection.smartSection {
		case .starred: "Star a story to keep it here."
		case .today: "Stories received today will appear here."
		case .lastSevenDays: "Stories received in the last 7 days will appear here."
		case .forYou: "Pigeon will surface unread stories as it learns what you like."
		case .unread: "New stories will appear here as Pigeon receives them."
		case .saved: "Saved links appear here."
		case nil: "New stories will appear here as Pigeon receives them."
		}
	}

	private var filteredEmptyTitle: String {
		switch model.articleFilter(for: collection) {
		case .all: "No stories yet"
		case .unread: "No unread stories"
		case .read: "No read stories"
		}
	}

	private var filteredEmptySystemImage: String {
		switch model.articleFilter(for: collection) {
		case .all: "newspaper"
		case .unread: "checkmark.circle"
		case .read: "envelope.open"
		}
	}

	private var filteredEmptyDescription: String {
		switch model.articleFilter(for: collection) {
		case .all: "New stories will appear here as Pigeon receives them."
		case .unread: "All stories in this collection are read. Choose All to see them."
		case .read: "All stories in this collection are unread. Choose All to see them."
		}
	}

	private func readButton(for article: Recommendation) -> some View {
		Button(article.isRead ? "Mark Unread" : "Mark Read", systemImage: article.isRead ? "envelope.badge" : "checkmark.circle") {
			model.retainPresentedArticles(updateBuffer.articles, in: collection, order: presentedOrder)
			actionFeedbackCount += 1
			Task {
				await model.setRead(article, read: !article.isRead, animation: reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false), offersUndo: true)
			}
		}
		.tint(PigeonPalette.SwipeFill.tint)
	}

	private func starButton(for article: Recommendation) -> some View {
		Button(article.isStarred ? "Unstar" : "Star", systemImage: article.isStarred ? "star.slash" : "star") {
			model.retainPresentedArticles(updateBuffer.articles, in: collection, order: presentedOrder)
			actionFeedbackCount += 1
			Task {
				await model.setStarred(article, starred: !article.isStarred, animation: reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false), offersUndo: true)
			}
		}
		.tint(PigeonPalette.SwipeFill.keep)
	}

	private func readItLaterButton(for article: Recommendation) -> some View {
		Button("Read It Later", systemImage: "bookmark") {
			Task { await saveForLater(article) }
		}
		.tint(PigeonPalette.SwipeFill.readLater)
		.accessibilityHint("Saves this article's original web page to Read It Later")
	}

	private func saveForLater(_ article: Recommendation) async {
		let requestPresentationID = presentationID
		guard let url = article.safeOriginalURL else {
			presentSaveErrorMessage("This article does not have a valid web address.")
			return
		}

		do {
			let outcome = try await model.saveForLater(url, title: article.title)
			guard requestPresentationID == presentationID else { return }
			presentSaveConfirmation(outcome.confirmationMessage, isSuccess: outcome.isSuccess)
		} catch is CancellationError {
			// Leaving the list is a normal cancellation; do not claim the save failed.
		} catch {
			guard requestPresentationID == presentationID else { return }
			presentSaveErrorMessage(error.localizedDescription)
		}
	}

	private func presentSaveErrorMessage(_ message: String) {
		saveConfirmation = nil
		saveErrorMessage = message
		isShowingSaveErrorMessage = true
	}

	private func presentSaveConfirmation(_ message: String, isSuccess: Bool) {
		saveConfirmation = ReaderSaveConfirmation(message: message, isSuccess: isSuccess)
	}

	private func resetSavePresentation() {
		presentationID = UUID()
		saveConfirmation = nil
		isShowingSaveErrorMessage = false
	}

	/// `order` is the on-screen order when it differs from the collection's,
	/// and `position` the copy of the story the menu was opened on.
	private func markAboveButton(for article: Recommendation, order: [Recommendation]? = nil, at position: Int? = nil) -> some View {
		Button("Mark Above as Read", systemImage: "arrow.up.circle") {
			model.retainPresentedArticles(updateBuffer.articles, in: collection, order: presentedOrder)
			Task { await model.markStoriesAboveAsRead(article, in: collection, order: order, at: position) }
		}
		.tint(PigeonPalette.SwipeFill.tint)
	}

	private func markBelowButton(for article: Recommendation, order: [Recommendation]? = nil, at position: Int? = nil) -> some View {
		Button("Mark Below as Read", systemImage: "arrow.down.circle") {
			model.retainPresentedArticles(updateBuffer.articles, in: collection, order: presentedOrder)
			Task { await model.markStoriesBelowAsRead(article, in: collection, order: order, at: position) }
		}
		.tint(PigeonPalette.SwipeFill.tint)
	}

}

private struct ReaderListSourceSnapshot: Equatable {
	let context: String
	let articles: [Recommendation]
	let allArticles: [Recommendation]
	let mutationRevision: UInt64
	let mutationArticleID: String?
}

/// What the reading log needs from the cards: each story once, in order of
/// first appearance, and the card that shows it first.
private struct CardImpressionRows: Equatable {
	let ids: [String]
	let rows: [String: String]

	init(sections: FolderSections) {
		ids = sections.uniqueArticleIDs
		rows = sections.readingLogRows
	}
}

private struct AutomaticPageRequest: Equatable {
	let context: String
	let token: String?
	let nearEnd: Bool
	let ready: Bool
	let movement: Int
}
