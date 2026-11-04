import SwiftUI

/// The Read It Later queue. Editorial rows (thumbnail, serif title, quiet
/// source line); actions live in each row's context menu, not in swipes.
struct ReadItLaterListView: View {
	let collection: ReaderNavigationItem
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var actionFeedbackCount = 0
	@State private var copyConfirmation: ReaderSaveConfirmation?

	var body: some View {
		let articles = model.articles(for: collection)
		let isArchive = model.articleFilter(for: collection) == .read
		Group {
			if articles.isEmpty {
				emptyState(isArchive: isArchive)
			} else {
				List {
					ForEach(articles) { article in
						ReadItLaterRowView(
							article: article,
							remoteImagePolicy: model.readerTypography.remoteImagePolicy,
							imageProxySession: model.session,
							select: { model.select(article: article) },
						)
						.listRowBackground(model.selectedArticleID == article.id ? Color.accentColor.opacity(0.1) : .clear)
						.contextMenu { actions(for: article) }
					}
				}
				.listStyle(.plain)
				.animation(ReaderMotion.animation(reduceMotion: reduceMotion), value: articles.map(\.id))
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.accessibilityElement(children: .contain)
		.accessibilityIdentifier("collection-pane-\(collection.id)")
		.navigationTitle(collection.title)
		.toolbar {
			if model.selectedNavigationID == collection.id {
				ReadItLaterToolbar(collection: collection)
			}
		}
		.refreshable {
			await model.refresh(collection: collection)
		}
		.task(id: model.session?.storageIdentity) {
			await model.loadForDisplay(collection: collection)
		}
		.sensoryFeedback(.selection, trigger: actionFeedbackCount)
		.modifier(ReaderSaveConfirmationModifier(confirmation: $copyConfirmation))
	}

	@ViewBuilder
	private func emptyState(isArchive: Bool) -> some View {
		if model.isInitialLoadPending(for: collection) {
			ProgressView("Loading Read It Later")
		} else if isArchive {
			ContentUnavailableView(
				"Nothing archived",
				systemImage: "archivebox",
				description: Text("Saved items you finish move here."),
			)
		} else if model.savedListFilter.isDefault == false {
			ContentUnavailableView {
				Label("No matches", systemImage: "line.3.horizontal.decrease")
			} description: {
				Text("Nothing saved matches these filters.")
			} actions: {
				Button("Show Everything") {
					model.savedListFilter = SavedListFilter()
				}
			}
		} else {
			ContentUnavailableView(
				"Nothing saved yet",
				systemImage: "bookmark",
				description: Text("Long-press a link in any article, or share a page to Pigeon, to read it later."),
			)
		}
	}

	@ViewBuilder
	private func actions(for article: Recommendation) -> some View {
		Button(article.isRead ? "Unarchive" : "Archive", systemImage: article.isRead ? "tray.and.arrow.up" : "archivebox") {
			actionFeedbackCount &+= 1
			Task { await model.setArchived(article, archived: !article.isRead) }
		}
		if let url = article.safeOriginalURL {
			Link(destination: url) {
				Label("Open Original", systemImage: "safari")
			}
			Button("Copy Link", systemImage: "doc.on.doc") {
				UIPasteboard.general.url = url
				copyConfirmation = ReaderSaveConfirmation(message: "Link copied", isSuccess: true)
			}
		}
		Divider()
		Button("Remove", systemImage: "trash", role: .destructive) {
			actionFeedbackCount &+= 1
			Task { await model.removeSaved(article) }
		}
	}
}

/// Unread/Archive, Text/Video, length, and sort, kept in two menus.
struct ReadItLaterToolbar: ToolbarContent {
	let collection: ReaderNavigationItem
	@Environment(ReaderAppModel.self) private var model

	var body: some ToolbarContent {
		ToolbarItemGroup(placement: .topBarTrailing) {
			Menu("Filter", systemImage: model.savedListFilter.isDefault
				? "line.3.horizontal.decrease"
				: "line.3.horizontal.decrease.circle.fill") {
				Picker("Status", selection: statusBinding) {
					Text("Unread").tag(ReaderArticleFilter.unread)
					Text("Archive").tag(ReaderArticleFilter.read)
				}
				.accessibilityIdentifier("saved-filter-status")
				Picker("Kind", selection: kindBinding) {
					ForEach(SavedKindFilter.allCases) { kind in
						Text(kind.title).tag(kind)
					}
				}
				.accessibilityIdentifier("saved-filter-kind")
				Picker("Length", selection: lengthBinding) {
					ForEach(SavedLengthFilter.allCases) { length in
						Text(length.title).tag(length)
					}
				}
				.accessibilityIdentifier("saved-filter-length")
			}
			.accessibilityLabel("Filter Read It Later")
			.accessibilityValue(filterSummary)
			.accessibilityIdentifier("saved-filter")

			Menu("Sort", systemImage: "arrow.up.arrow.down") {
				Picker("Sort", selection: sortBinding) {
					ForEach(model.availableSortOrders(for: collection)) { order in
						Label(order.title, systemImage: order.systemImage).tag(order)
					}
				}
			}
			.accessibilityLabel("Sort Read It Later")
			.accessibilityValue(model.sortOrder(for: collection).title)
			.accessibilityIdentifier("saved-sort")
		}
	}

	private var filterSummary: String {
		let status = model.articleFilter(for: collection) == .read ? "Archive" : "Unread"
		return [status, model.savedListFilter.kind.title, model.savedListFilter.length.title].joined(separator: ", ")
	}

	private var statusBinding: Binding<ReaderArticleFilter> {
		Binding(
			get: { model.articleFilter(for: collection) == .read ? .read : .unread },
			set: { model.setArticleFilter($0, for: collection) },
		)
	}

	private var kindBinding: Binding<SavedKindFilter> {
		Binding(
			get: { model.savedListFilter.kind },
			set: { model.savedListFilter.kind = $0 },
		)
	}

	private var lengthBinding: Binding<SavedLengthFilter> {
		Binding(
			get: { model.savedListFilter.length },
			set: { model.savedListFilter.length = $0 },
		)
	}

	private var sortBinding: Binding<ArticleSortOrder> {
		Binding(
			get: { model.sortOrder(for: collection) },
			set: { model.setSortOrder($0, for: collection) },
		)
	}
}

struct ReadItLaterRowView: View {
	let article: Recommendation
	let remoteImagePolicy: ReaderRemoteImagePolicy
	let imageProxySession: PigeonSession?
	let select: () -> Void

	var body: some View {
		Button(action: select) {
			HStack(alignment: .top, spacing: 14) {
				VStack(alignment: .leading, spacing: 6) {
					Text(article.title)
						.font(ReaderTypography.storyTitle)
						.foregroundStyle(.primary)
						.multilineTextAlignment(.leading)
						.lineLimit(3)
					Text(metadataLine)
						.font(.caption)
						.foregroundStyle(.secondary)
						.lineLimit(1)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				if let thumbnailURL = article.savedThumbnailURL {
					ArticleListThumbnailView(
						remoteURL: thumbnailURL,
						policy: remoteImagePolicy,
						session: imageProxySession,
					)
				}
			}
			.padding(.vertical, 6)
			.contentShape(.rect)
		}
		.buttonStyle(ReaderRowButtonStyle())
		.accessibilityElement(children: .combine)
		.accessibilityIdentifier("saved-row-\(article.id)")
	}

	/// "Example Essays · 12 min · 2 hours ago", with the extraction state while
	/// the text is not ready yet.
	private var metadataLine: String {
		var parts = [article.savedSourceName]
		switch article.savedState {
		case .pending?: parts.append(article.isSavedVideo ? "Video" : "Preparing")
		case .failed?: parts.append("Text unavailable")
		default:
			if let minutes = SavedLength.minutes(for: article) {
				parts.append(article.isSavedVideo ? "\(minutes) min video" : "\(minutes) min")
			} else if article.isSavedVideo {
				parts.append("Video")
			}
		}
		parts.append(article.receivedAt.formatted(.relative(presentation: .named)))
		return parts.joined(separator: " · ")
	}
}

/// Shown in place of the body while a saved page is extracted, or after the
/// extraction failed.
struct SavedArticleExtractionView: View {
	let article: Recommendation
	let onOpenOriginal: () -> Void
	let onRetry: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: 14) {
			if article.savedState == .failed {
				Label("Pigeon couldn’t get the text of this page", systemImage: "exclamationmark.triangle")
					.font(.headline)
				Text("You can read it on the original site, or try again.")
					.foregroundStyle(.secondary)
				HStack(spacing: 12) {
					Button("Open Original", systemImage: "safari", action: onOpenOriginal)
						.buttonStyle(.borderedProminent)
						.disabled(article.safeOriginalURL == nil)
						.accessibilityIdentifier("saved-open-original")
					Button("Try Again", systemImage: "arrow.clockwise", action: onRetry)
						.buttonStyle(.bordered)
						.accessibilityIdentifier("saved-try-again")
				}
			} else {
				HStack(spacing: 10) {
					ProgressView()
					Text("Preparing the article…")
						.foregroundStyle(.secondary)
				}
				.accessibilityElement(children: .combine)
				.accessibilityIdentifier("saved-preparing")
				Button("Open Original", systemImage: "safari", action: onOpenOriginal)
					.buttonStyle(.bordered)
					.disabled(article.safeOriginalURL == nil)
			}
		}
		.frame(maxWidth: .infinity, minHeight: 160, alignment: .topLeading)
	}
}
