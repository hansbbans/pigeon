import SwiftUI

struct ArticleListView: View {
	let collection: ReaderNavigationItem
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
		@Bindable var model = model
		let allArticles = model.allArticles(for: collection)
		let articles = model.articles(for: collection)
		let isLoading = model.isLoading(collection: collection)
		let isFilteredEmpty = model.isArticleFilterEmpty(for: collection)

		Group {
			if isLoading && allArticles.isEmpty {
				ProgressView("Loading stories")
					.frame(maxWidth: .infinity, maxHeight: .infinity)
			} else if articles.isEmpty {
				if isFilteredEmpty {
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
			} else {
				List(articles) { article in
					Button {
						model.select(article: article)
					} label: {
						ArticleRowView(article: article)
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
				.listStyle(.plain)
			}
		}
		.navigationTitle(collection.title)
		.refreshable {
			await model.refresh(collection: collection)
		}
		.task(id: collection.id) {
			await model.load(collection: collection)
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

				Button("Refresh", systemImage: "arrow.clockwise") {
					Task { await model.refresh(collection: collection) }
				}
				.keyboardShortcut("r", modifiers: .command)
				.disabled(isLoading)
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
}
