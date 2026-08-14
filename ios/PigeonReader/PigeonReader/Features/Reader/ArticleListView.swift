import SwiftUI

struct ArticleListView: View {
	let collection: ReaderNavigationItem
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
		@Bindable var model = model
		let articles = model.articles(for: collection)
		let isLoading = model.isLoading(collection: collection)
		let isUnreadFilterEmpty = model.isUnreadArticleFilterEmpty(for: collection)

		Group {
			if isLoading && articles.isEmpty {
				ProgressView("Loading stories")
					.frame(maxWidth: .infinity, maxHeight: .infinity)
			} else if isUnreadFilterEmpty {
				ContentUnavailableView(
					"No unread stories",
					systemImage: "checkmark.circle",
					description: Text("All stories in this collection are read. Turn off Unread only to see them."),
				)
			} else if articles.isEmpty {
				ContentUnavailableView(
					emptyTitle,
					systemImage: emptySystemImage,
					description: Text(emptyDescription),
				)
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
				Toggle("Unread only", systemImage: "envelope.badge", isOn: $model.isArticleListUnreadOnly)
					.toggleStyle(.button)
					.accessibilityLabel(ReaderAccessibilityText.unreadStoriesOnly)
					.accessibilityValue(model.isArticleListUnreadOnly ? "On" : "Off")
					.accessibilityHint("Shows only unread stories in this collection.")

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
