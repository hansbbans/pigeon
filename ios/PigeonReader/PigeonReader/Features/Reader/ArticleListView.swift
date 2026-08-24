import SwiftUI

struct ArticleListView: View {
	let collection: ReaderNavigationItem
	@Environment(ReaderAppModel.self) private var model
	@State private var searchText = ""
	@State private var searchScope = ReaderSearchScope.collection

	var body: some View {
		@Bindable var model = model
		let allArticles = model.allArticles(for: collection)
		let isSearchActive = searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
		let articles = isSearchActive ? model.searchResults : model.articles(for: collection)
		let isLoading = model.isLoading(collection: collection)
		let isFilteredEmpty = model.isArticleFilterEmpty(for: collection)

		Group {
			if isLoading && allArticles.isEmpty {
				ProgressView("Loading stories")
					.frame(maxWidth: .infinity, maxHeight: .infinity)
			} else if model.isSearchingArticles && articles.isEmpty {
				ProgressView("Searching saved stories")
					.frame(maxWidth: .infinity, maxHeight: .infinity)
			} else if articles.isEmpty {
				VStack {
					if isSearchActive {
						ContentUnavailableView.search(text: searchText)
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
			} else {
				List {
					ForEach(articles) { article in
						Button {
							model.select(article: article)
						} label: {
							ArticleRowView(
								article: article,
								density: model.readerTypography.timelineDensity,
								remoteImagePolicy: model.readerTypography.remoteImagePolicy,
							)
						}
						.buttonStyle(.plain)
						.listRowBackground(model.selectedArticleID == article.id ? Color.accentColor.opacity(0.1) : .clear)
						.swipeActions(edge: .leading, allowsFullSwipe: true) {
							readButton(for: article)
						}
						.swipeActions(edge: .trailing, allowsFullSwipe: true) {
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
				.accessibilityIdentifier("article-list")
			}
		}
		.navigationTitle(collection.title)
		.searchable(text: $searchText, prompt: "Titles, authors, feeds, and text")
		.searchScopes($searchScope) {
			ForEach(ReaderSearchScope.allCases) { scope in
				Text(scope == .collection ? collection.title : scope.title).tag(scope)
			}
		}
		.refreshable {
			await model.refresh(collection: collection)
		}
		.task(id: collection.id) {
			searchText = ""
			model.clearArticleSearch()
			await model.load(collection: collection)
		}
		.task(id: ArticleSearchRequest(query: searchText, scope: searchScope, collectionID: collection.id)) {
			let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
			guard query.isEmpty == false else {
				model.clearArticleSearch()
				return
			}
			try? await Task.sleep(for: .milliseconds(250))
			guard Task.isCancelled == false else { return }
			await model.searchArticles(query: query, scope: searchScope, in: collection)
		}
		.toolbar {
			ToolbarItemGroup(placement: .topBarTrailing) {
				Menu("Filter", systemImage: "line.3.horizontal.decrease") {
					Picker("Filter stories", selection: $model.articleFilter) {
						ForEach(ReaderArticleFilter.allCases) { filter in
							Text(filter.title)
								.tag(filter)
						}
					}
				}
				.accessibilityLabel(ReaderAccessibilityText.filterStories(for: collection.title))
				.accessibilityValue(model.articleFilter.title)
				.accessibilityHint(ReaderAccessibilityText.filterStoriesHint)

				Menu("Sort", systemImage: "arrow.up.arrow.down") {
					Picker("Sort stories", selection: $model.sortOrder) {
						ForEach(ArticleSortOrder.allCases) { sortOrder in
							Label(sortOrder.title, systemImage: sortOrder.systemImage)
								.tag(sortOrder)
						}
					}
				}
				.accessibilityLabel(ReaderAccessibilityText.sortStories(for: collection.title))

				Menu("Display", systemImage: "rectangle.grid.1x2") {
					Picker("Timeline density", selection: Binding(
						get: { model.readerTypography.timelineDensity },
						set: { model.readerTypography.timelineDensity = $0 },
					)) {
						ForEach(ReaderTimelineDensity.allCases) { density in
							Text(density.title).tag(density)
						}
					}
				}
				.accessibilityValue(model.readerTypography.timelineDensity.title)

				Menu("Read actions", systemImage: "checkmark.circle") {
					Button("Mark All as Read", systemImage: "checkmark.circle") {
						Task { await model.markAllStoriesAsRead(in: collection) }
					}
					.disabled(allArticles.contains(where: { $0.isRead == false }) == false)
					Divider()
					olderThanButton(days: 1)
					olderThanButton(days: 7)
					olderThanButton(days: 30)
					if model.canUndoBulkRead(in: collection) {
						Divider()
						Button("Undo \(model.bulkReadUndoTitle ?? "Last Read Action")", systemImage: "arrow.uturn.backward") {
							Task { await model.undoLastBulkRead() }
						}
						.keyboardShortcut("z", modifiers: .command)
					}
				}
				.accessibilityHint("Marks stories read or reverses the most recent bulk read action")

				Button("Refresh", systemImage: "arrow.clockwise") {
					Task { await model.refresh(collection: collection) }
				}
				.keyboardShortcut("r", modifiers: .command)
				.disabled(isLoading)
			}
			ReaderSettingsToolbarItem()
		}
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
					Task { await model.loadMore(collection: collection) }
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
				.disabled(model.isLoading(collection: collection) || model.isLoadingMore(collection: collection))
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
		switch model.articleFilter {
		case .all: "No stories yet"
		case .unread: "No unread stories"
		case .read: "No read stories"
		}
	}

	private var filteredEmptySystemImage: String {
		switch model.articleFilter {
		case .all: "newspaper"
		case .unread: "checkmark.circle"
		case .read: "envelope.open"
		}
	}

	private var filteredEmptyDescription: String {
		switch model.articleFilter {
		case .all: "New stories will appear here as Pigeon receives them."
		case .unread: "All stories in this collection are read. Choose All to see them."
		case .read: "All stories in this collection are unread. Choose All to see them."
		}
	}

	private func readButton(for article: Recommendation) -> some View {
		Button(article.isRead ? "Mark Unread" : "Mark Read", systemImage: article.isRead ? "envelope.badge" : "checkmark.circle") {
			Task { await model.setRead(article, read: !article.isRead) }
		}
		.tint(.blue)
	}

	private func starButton(for article: Recommendation) -> some View {
		Button(article.isStarred ? "Unstar" : "Star", systemImage: article.isStarred ? "star.slash" : "star") {
			Task { await model.setStarred(article, starred: !article.isStarred) }
		}
		.tint(.orange)
	}

	private func markAboveButton(for article: Recommendation) -> some View {
		Button("Mark Above as Read", systemImage: "arrow.up.circle") {
			Task { await model.markStoriesAboveAsRead(article, in: collection) }
		}
		.tint(.blue)
	}

	private func markBelowButton(for article: Recommendation) -> some View {
		Button("Mark Below as Read", systemImage: "arrow.down.circle") {
			Task { await model.markStoriesBelowAsRead(article, in: collection) }
		}
		.tint(.blue)
	}

	private func olderThanButton(days: Int) -> some View {
		Button("Older than \(days) \(days == 1 ? "day" : "days")", systemImage: "calendar.badge.checkmark") {
			let cutoff = Calendar.current.date(byAdding: .day, value: -days, to: .now) ?? .now
			Task { await model.markStoriesOlderThan(cutoff, in: collection) }
		}
	}
}

private struct ArticleSearchRequest: Equatable {
	let query: String
	let scope: ReaderSearchScope
	let collectionID: String
}
