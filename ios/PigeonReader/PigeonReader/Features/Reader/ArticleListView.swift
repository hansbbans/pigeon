import SwiftUI

struct ArticleListView: View {
	let destination: ReaderDestination
	var selectedArticle: ((Recommendation) -> Void)? = nil
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
		@Bindable var model = model
		let articles = model.articles(for: destination)
		let isLoading = model.isLoading(section: destination.sourceSection)
		let title = model.selectedDestination == destination ? model.selectedDestinationTitle : "Stories"
		let section = destination.sourceSection

		Group {
			if isLoading && articles.isEmpty {
				ProgressView("Loading stories")
					.frame(maxWidth: .infinity, maxHeight: .infinity)
			} else if articles.isEmpty {
				ContentUnavailableView(
					destination == .section(.starred) ? "No starred stories" : "You are all caught up",
					systemImage: destination == .section(.starred) ? "star" : "checkmark.circle",
					description: Text(destination == .section(.starred) ? "Star a story to keep it here." : "New stories will appear here as Pigeon receives them.")
				)
			} else {
				List(articles) { article in
					Button {
						model.select(article: article)
						selectedArticle?(article)
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
					}
				}
				.listStyle(.plain)
			}
		}
		.navigationTitle(title)
		.refreshable {
			await model.load(destination: destination, force: true)
		}
		.task(id: destination) {
			await model.load(destination: destination)
		}
		.toolbar {
			ToolbarItemGroup(placement: .topBarTrailing) {
				Menu("Sort", systemImage: "arrow.up.arrow.down") {
					Picker("Sort stories", selection: Binding(
						get: { model.sortOrder(for: section) },
						set: { model.setSortOrder($0, for: section) }
					)) {
						ForEach(ArticleSortOrder.allCases) { sortOrder in
							Label(sortOrder.title, systemImage: sortOrder.systemImage)
								.tag(sortOrder)
						}
					}
				}
				.accessibilityLabel("Sort \(title) stories")

				Button("Refresh", systemImage: "arrow.clockwise") {
					Task { await model.load(destination: destination, force: true) }
				}
				.keyboardShortcut("r", modifiers: .command)
				.disabled(isLoading)
			}
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
}
