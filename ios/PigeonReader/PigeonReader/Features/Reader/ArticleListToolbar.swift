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
		ReaderHomeToolbarItem()
		ToolbarItemGroup(placement: .topBarTrailing) {
			if collection.kind == .feed {
				Button("Mark Read", systemImage: "checkmark.circle") {
					Task { await model.markAllStoriesAsRead(in: collection) }
				}
				.disabled(model.canMarkAllStoriesAsRead(in: collection) == false)
				.accessibilityValue(model.markingAllReadCollectionID == collection.id ? "Marking all as read" : "")
				.accessibilityHint("Marks all unread stories in this feed as read")
				.accessibilityIdentifier("article-list-mark-read")
			}
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
			// Its own view, fed plain values: the list's body runs on every sync and
			// cache change, and each run would rebuild the menu and collapse an
			// expanded Sort or Display while the reader is choosing.
			ArticleListMoreMenu(
				collection: collection,
				state: ArticleListMoreMenu.State(
					isMarkingAllRead: model.markingAllReadCollectionID == collection.id,
					canMarkAllRead: model.canMarkAllStoriesAsRead(in: collection),
					undoTitle: model.canUndoBulkRead(in: collection)
						? model.bulkReadUndoTitle ?? "Last Read Action"
						: nil,
				),
				onListContextWillChange: onListContextWillChange,
				onTimelineDensityWillChange: onTimelineDensityWillChange,
			)
			.equatable()
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
}

/// The list's More menu. It is `Equatable` on what it shows, so SwiftUI only
/// rebuilds it when one of those values changes, never because the list did.
struct ArticleListMoreMenu: View, Equatable {
	nonisolated struct State: Equatable {
		let isMarkingAllRead: Bool
		let canMarkAllRead: Bool
		/// Nil when there is nothing to undo here.
		let undoTitle: String?
	}

	let collection: ReaderNavigationItem
	let state: State
	let onListContextWillChange: () -> Void
	let onTimelineDensityWillChange: () -> Void
	@Environment(ReaderAppModel.self) private var model

	/// Ignores the unread count, which changes with every sync; the model reads
	/// current counts itself when an action runs.
	nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
		lhs.collection.replacingUnreadCount(0) == rhs.collection.replacingUnreadCount(0)
			&& lhs.state == rhs.state
	}

	var body: some View {
		Menu("More", systemImage: "ellipsis") {
			// In Cards a folder's or feed's sections are its order.
			if hidesSort == false {
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
			}

			Menu("Display", systemImage: "rectangle.grid.1x2") {
				Picker("Look", selection: lookBinding) {
					ForEach(ReaderLook.allCases) { look in
						Text(look.title).tag(look)
					}
				}
				.accessibilityIdentifier("article-list-layout-options")
				// Density only shapes Reeder's rows.
				if usesCards == false {
					Picker("Timeline density", selection: densityBinding) {
						ForEach(ReaderTimelineDensity.allCases) { density in
							Text(density.title).tag(density)
						}
					}
					.accessibilityIdentifier("article-list-density-options")
				}
			}
			.accessibilityValue(usesCards
				? ReaderLook.cards.title
				: model.readerTypography.timelineDensity.title)
			.accessibilityIdentifier("article-list-density")

			Menu("Read actions", systemImage: "checkmark.circle") {
				Button(state.isMarkingAllRead ? "Marking All as Read…" : "Mark All as Read", systemImage: "checkmark.circle") {
					Task { await model.markAllStoriesAsRead(in: collection) }
				}
				.disabled(state.canMarkAllRead == false)
				Divider()
				olderThanButton(days: 1)
				olderThanButton(days: 7)
				olderThanButton(days: 30)
				if let undoTitle = state.undoTitle {
					Divider()
					Button("Undo \(undoTitle)", systemImage: "arrow.uturn.backward") {
						Task { await model.undoLastBulkRead() }
					}
					.keyboardShortcut("z", modifiers: .command)
				}
			}
			.accessibilityHint("Marks stories read or reverses the most recent bulk read action")

			Button("Refresh", systemImage: "arrow.clockwise") {
				Task { await model.refresh(collection: collection) }
			}
			// Not disabled while loading: that flips on every background sync and
			// would rebuild the open menu. A refresh during a sync joins it.
			.keyboardShortcut("r", modifiers: .command)
			Divider()
			Button("Settings", systemImage: "gearshape") {
				model.isShowingSettings = true
			}
			.keyboardShortcut(",", modifiers: .command)
		}
		.accessibilityIdentifier("article-list-more")
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

	private var usesCards: Bool {
		model.readerTypography.look == .cards
	}

	private var hidesSort: Bool {
		usesCards && (collection.kind == .folder || collection.kind == .feed)
	}

	private var lookBinding: Binding<ReaderLook> {
		Binding(
			get: { model.readerTypography.look },
			set: { model.readerTypography.look = $0 },
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
