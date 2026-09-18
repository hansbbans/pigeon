import SwiftUI

struct ArticleListView: View {
	let collection: ReaderNavigationItem
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.readerCollectionIsTransitioning) private var isCollectionTransitioning
	@Environment(\.horizontalSizeClass) private var horizontalSizeClass
	@Environment(\.dynamicTypeSize) private var dynamicTypeSize
	@State private var searchText = ""
	@State private var searchScope = ReaderSearchScope.collection
	@State private var searchPresentation = ReaderArticleSearchPresentation()
	@State private var searchAttempt = 0
	@State private var readwiseSaveMessage: String?
	@State private var isShowingReadwiseSaveMessage = false
	@State private var saveConfirmation: ReaderSaveConfirmation?
	@State private var actionFeedbackCount = 0
	@State private var presentationID = UUID()
	@State private var viewport = ReaderListViewportController()
	@State private var isNearEnd = false
	@State private var paginationGate = ReaderAutomaticPaginationGate()
	@State private var paginationContext = ""
	@State private var paginationMovement = 0
	@State private var loadingState = ReaderCollectionLoadingState()
	@State private var reloadGeneration = 0
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

	var body: some View {
		let allArticles = model.allArticles(for: collection)
		let searchRequest = currentSearchRequest
		let isSearchActive = searchRequest.isActive
		let searchPhase = searchPresentation.phase(for: searchRequest)
		let sourceArticles = isSearchActive
			? (searchPresentation.canDisplayResults(for: searchRequest) ? model.searchResults : [])
			: model.articles(for: collection)
		let articles = updateBuffer.displayedArticles(in: listContext, fallback: sourceArticles)
		let hasSavedPosition = model.listPositions.position(for: listContext)?.target(in: articles.map(\.id)) != nil
		let isPositionReady = (hasSavedPosition == false || readyContext == listContext)
			&& isExplicitListTransitioning == false
		let holdsUpdates = isScrolling || isNativeTransitioning || isCollectionTransitioning
			|| isExplicitListTransitioning || isLayoutReflowing || isPositionReady == false
			|| (horizontalSizeClass == .compact && model.preferredCompactColumn == .detail)
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
			&& model.readerTypography.timelineDensity == .imageRich
			&& model.readerTypography.remoteImagePolicy == .normal
		let thumbnailRequest = ReaderFeedThumbnailPrefetchRequest(
			scope: preparesThumbnails ? model.session?.storageIdentity : nil,
			articles: preparesThumbnails ? Array(articles.prefix(ReaderFeedThumbnailPolicy.firstScreenLimit)) : [],
		)

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
			} else {
				ScrollViewReader { proxy in
					List {
						ForEach(articles) { article in
							ArticleRowView(
								article: article,
								density: model.readerTypography.timelineDensity,
								remoteImagePolicy: model.readerTypography.remoteImagePolicy,
								thumbnailStore: ReaderFeedThumbnailStore.shared,
								thumbnailScope: model.session?.storageIdentity,
								imageProxySession: model.session,
								select: {
									model.retainPresentedArticles(articles, in: collection)
									model.select(article: article)
								},
							)
							.id(article.id)
							.background { ReaderListRowAnchor(articleID: article.id, controller: viewport) }
							.listRowBackground(model.selectedArticleID == article.id ? Color.accentColor.opacity(0.1) : .clear)
							.swipeActions(edge: .leading, allowsFullSwipe: true) {
								readButton(for: article)
							}
							.swipeActions(edge: .trailing, allowsFullSwipe: true) {
								saveToReaderButton(for: article)
								starButton(for: article)
							}
							.contextMenu {
								readButton(for: article)
								starButton(for: article)
								Divider()
								markAboveButton(for: article)
								markBelowButton(for: article)
							}
						}
						Text(model.collectionStatusText(for: collection))
							.font(.footnote)
							.foregroundStyle(.secondary)
							.frame(maxWidth: .infinity, alignment: .center)
							.listRowSeparator(.hidden)
							.accessibilityLabel("Collection status: \(model.collectionStatusText(for: collection))")
						loadMoreControls(for: collection, isSearchActive: isSearchActive)
					}
					.listStyle(.plain)
					.task(id: thumbnailRequest) {
						guard let scope = thumbnailRequest.scope, thumbnailRequest.articles.isEmpty == false else { return }
						await ReaderFeedThumbnailStore.shared.prefetch(articles: thumbnailRequest.articles, scope: scope)
					}
					.opacity(isPositionReady ? (isLayoutReflowing ? 0.92 : 1) : 0)
					.allowsHitTesting(isPositionReady && isLayoutReflowing == false)
					.accessibilityHidden(isPositionReady == false || isLayoutReflowing)
					.animation(ReaderMotion.contentArrival(reduceMotion: reduceMotion), value: isPositionReady)
					.animation(ReaderMotion.contentArrival(reduceMotion: reduceMotion), value: isLayoutReflowing)
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
							context: listContext, articleIDs: articles.map(\.id), store: model.listPositions,
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
						guard let request = acceptedScrollRequest, let firstID = articles.first?.id else { return }
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
					.onChange(of: articles.map(\.id)) { _, ids in viewport.updateArticleIDs(ids) }
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
			updateBuffer.receive(source.articles, context: source.context, holding: holding,
				explicit: isUserRefreshing || isSearchActive, knownArticles: source.allArticles)
		}
		.onChange(of: listContext) { _, context in
			viewport.commitContextChange(to: context, scope: listScope)
			if isExplicitListTransitioning && articles.isEmpty {
				readyContext = context
				isExplicitListTransitioning = false
			}
		}
		.onChange(of: dynamicTypeSize) {
			prepareForDynamicTypeReflow()
		}
		.allowsHitTesting(model.selectedNavigationID == collection.id)
		.accessibilityHidden(model.selectedNavigationID != collection.id)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("collection-pane-\(collection.id)")
		.navigationTitle(navigationTitle)
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
			guard paginationGate.claim(token, hasError: model.loadMoreError(for: collection) != nil) else { return }
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
		.alert("Couldn’t Save to Reader", isPresented: $isShowingReadwiseSaveMessage) {
		} message: {
			Text(readwiseSaveMessage ?? "")
		}
	}

	private var loadRequestKey: String {
		"\(model.session?.storageIdentity ?? "none")|\(collection.id)|\(model.libraryGeneration)|\(reloadGeneration)"
	}

	private var navigationTitle: String {
		guard collection.smartSection == .today else { return collection.title }
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
		let requestID = loadingState.begin(context: loadRequestKey)
		searchText = ""
		searchPresentation = ReaderArticleSearchPresentation()
		model.clearArticleSearch()
		if reloadGeneration == 0 {
			await model.loadForDisplay(collection: collection)
		} else {
			await model.load(collection: collection, force: true)
		}
		guard Task.isCancelled == false else { return }
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
			|| (horizontalSizeClass == .compact && model.preferredCompactColumn == .detail)
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
					.foregroundStyle(.red)
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
		case .forYou: "No recommendations yet"
		case .unread: "You are all caught up"
		case nil: "No stories yet"
		}
	}

	private var emptySystemImage: String {
		switch collection.smartSection {
		case .starred: "star"
		case .today: "calendar"
		case .forYou: "sparkles"
		default: "checkmark.circle"
		}
	}

	private var emptyDescription: String {
		switch collection.smartSection {
		case .starred: "Star a story to keep it here."
		case .today: "Stories received today will appear here."
		case .forYou: "Pigeon will surface unread stories as it learns what you like."
		case .unread: "New stories will appear here as Pigeon receives them."
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
			model.retainPresentedArticles(updateBuffer.articles, in: collection)
			actionFeedbackCount += 1
			Task {
				await model.setRead(article, read: !article.isRead, animation: reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false), offersUndo: true)
			}
		}
		.tint(.blue)
	}

	private func starButton(for article: Recommendation) -> some View {
		Button(article.isStarred ? "Unstar" : "Star", systemImage: article.isStarred ? "star.slash" : "star") {
			model.retainPresentedArticles(updateBuffer.articles, in: collection)
			actionFeedbackCount += 1
			Task {
				await model.setStarred(article, starred: !article.isStarred, animation: reduceMotion ? nil : ReaderMotion.animation(reduceMotion: false), offersUndo: true)
			}
		}
		.tint(.orange)
	}

	private func saveToReaderButton(for article: Recommendation) -> some View {
		Button("Save to Reader", systemImage: "bookmark") {
			Task { await saveToReader(article) }
		}
		.tint(.green)
		.accessibilityHint("Saves this article's original web page to Readwise Reader")
	}

	private func saveToReader(_ article: Recommendation) async {
		let requestPresentationID = presentationID
		guard let url = article.safeOriginalURL, let destination = OutboundDestination(url: url) else {
			presentReadwiseSaveMessage("This article does not have a valid web address.")
			return
		}

		do {
			let outcome = try await model.saveToReader(destination)
			guard requestPresentationID == presentationID else { return }
			switch outcome {
			case .saved:
				presentSaveConfirmation("Saved to Reader", isSuccess: true)
			case .alreadyInFlight:
				presentSaveConfirmation("Already saving this link…", isSuccess: false)
			}
		} catch is CancellationError {
			// Leaving the list is a normal cancellation; do not claim the save failed.
		} catch {
			guard requestPresentationID == presentationID else { return }
			presentReadwiseSaveMessage(error.localizedDescription)
		}
	}

	private func presentReadwiseSaveMessage(_ message: String) {
		saveConfirmation = nil
		readwiseSaveMessage = message
		isShowingReadwiseSaveMessage = true
	}

	private func presentSaveConfirmation(_ message: String, isSuccess: Bool) {
		saveConfirmation = ReaderSaveConfirmation(message: message, isSuccess: isSuccess)
	}

	private func resetSavePresentation() {
		presentationID = UUID()
		saveConfirmation = nil
		isShowingReadwiseSaveMessage = false
	}

	private func markAboveButton(for article: Recommendation) -> some View {
		Button("Mark Above as Read", systemImage: "arrow.up.circle") {
			model.retainPresentedArticles(updateBuffer.articles, in: collection)
			Task { await model.markStoriesAboveAsRead(article, in: collection) }
		}
		.tint(.blue)
	}

	private func markBelowButton(for article: Recommendation) -> some View {
		Button("Mark Below as Read", systemImage: "arrow.down.circle") {
			model.retainPresentedArticles(updateBuffer.articles, in: collection)
			Task { await model.markStoriesBelowAsRead(article, in: collection) }
		}
		.tint(.blue)
	}

}

private struct ReaderListSourceSnapshot: Equatable {
	let context: String
	let articles: [Recommendation]
	let allArticles: [Recommendation]
	let mutationRevision: UInt64
	let mutationArticleID: String?
}

private struct AutomaticPageRequest: Equatable {
	let context: String
	let token: String?
	let nearEnd: Bool
	let ready: Bool
	let movement: Int
}
