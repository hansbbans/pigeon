import SwiftUI

struct ArticleListToolbar: ToolbarContent {
	let collection: ReaderNavigationItem
	let onListContextWillChange: () -> Void
	let onTimelineDensityWillChange: () -> Void
	@Environment(ReaderAppModel.self) private var model

	init(
		collection: ReaderNavigationItem,
		onListContextWillChange: @escaping () -> Void = {},
		onTimelineDensityWillChange: @escaping () -> Void = {},
	) {
		self.collection = collection
		self.onListContextWillChange = onListContextWillChange
		self.onTimelineDensityWillChange = onTimelineDensityWillChange
	}

	var body: some ToolbarContent {
		let isLoading = model.isLoading(collection: collection)

		ToolbarItemGroup(placement: .topBarTrailing) {
			Menu("Filter", systemImage: "line.3.horizontal.decrease") {
				Picker("Filter stories", selection: filterBinding) {
					ForEach(ReaderArticleFilter.allCases) { filter in
						Text(filter.title)
							.tag(filter)
					}
				}
				.accessibilityIdentifier("article-list-filter-options")
			}
			.accessibilityLabel(ReaderAccessibilityText.filterStories(for: collection.title))
			.accessibilityValue(model.articleFilter(for: collection).title)
			.accessibilityHint(ReaderAccessibilityText.filterStoriesHint)
			.accessibilityIdentifier("article-list-filter")
			Menu("More", systemImage: "ellipsis") {
				Menu("Sort", systemImage: "arrow.up.arrow.down") {
					Picker("Sort stories", selection: sortBinding) {
						ForEach(model.availableSortOrders(for: collection)) { sortOrder in
							Label(sortOrder.title, systemImage: sortOrder.systemImage)
								.tag(sortOrder)
						}
					}
					.accessibilityIdentifier("article-list-sort-options")
				}
				.accessibilityLabel(ReaderAccessibilityText.sortStories(for: collection.title))
				.accessibilityValue(model.sortOrder(for: collection).title)
				.accessibilityIdentifier("article-list-sort")

				Menu("Display", systemImage: "rectangle.grid.1x2") {
					Picker("Timeline density", selection: densityBinding) {
						ForEach(ReaderTimelineDensity.allCases) { density in
							Text(density.title).tag(density)
						}
					}
					.accessibilityIdentifier("article-list-density-options")
				}
				.accessibilityValue(model.readerTypography.timelineDensity.title)
				.accessibilityIdentifier("article-list-density")

				Menu("Read actions", systemImage: "checkmark.circle") {
					Button("Mark All as Read", systemImage: "checkmark.circle") {
						Task { await model.markAllStoriesAsRead(in: collection) }
					}
					.disabled(model.canMarkAllStoriesAsRead(in: collection) == false)
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
				Divider()
				Button("Settings", systemImage: "gearshape") {
					model.isShowingSettings = true
				}
				.keyboardShortcut(",", modifiers: .command)
			}
			.accessibilityIdentifier("article-list-more")
		}
	}

	private var filterBinding: Binding<ReaderArticleFilter> {
		Binding(
			get: { model.articleFilter(for: collection) },
			set: { newFilter in
				guard newFilter != model.articleFilter(for: collection) else { return }
				onListContextWillChange()
				model.setArticleFilter(newFilter, for: collection)
			},
		)
	}

	private var sortBinding: Binding<ArticleSortOrder> {
		Binding(
			get: { model.sortOrder(for: collection) },
			set: { newSortOrder in
				guard newSortOrder != model.sortOrder(for: collection) else { return }
				onListContextWillChange()
				model.setSortOrder(newSortOrder, for: collection)
			},
		)
	}

	private var densityBinding: Binding<ReaderTimelineDensity> {
		Binding(
			get: { model.readerTypography.timelineDensity },
			set: { newDensity in
				guard newDensity != model.readerTypography.timelineDensity else { return }
				onTimelineDensityWillChange()
				model.readerTypography.timelineDensity = newDensity
			},
		)
	}

	private func olderThanButton(days: Int) -> some View {
		Button("Older than \(days) \(days == 1 ? "day" : "days")", systemImage: "calendar.badge.checkmark") {
			let cutoff = Calendar.current.date(byAdding: .day, value: -days, to: .now) ?? .now
			Task { await model.markStoriesOlderThan(cutoff, in: collection) }
		}
	}
}
