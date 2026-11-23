import SwiftUI

struct ReaderShellView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.horizontalSizeClass) private var windowHorizontalSizeClass
	@Environment(\.scenePhase) private var scenePhase
	@State private var columnVisibility = NavigationSplitViewVisibility.all

	var body: some View {
		@Bindable var model = model
		let showsCompactArticle = ReaderCompactArticlePresentation.isActive(
			horizontalSizeClass: horizontalSizeClass,
			preferredColumn: model.preferredCompactColumn,
			hasSelectedArticle: model.selectedArticle != nil,
		)

		ZStack {
			if model.isInitialLibraryLoading {
				NavigationStack {
					ProgressView("Loading your library")
						.frame(maxWidth: .infinity, maxHeight: .infinity)
						.navigationTitle("Pigeon")
						.accessibilityIdentifier("library-startup-loading")
				}
			} else if model.readerTypography.look == .cards {
				// Cards navigates like a phone in every window: Home, then the
				// list, then a feed opened from a folder's card above the folder.
				// One stack, so the system back button and the edge swipe pop each
				// level and the folder underneath keeps its scroll and expanded
				// cards. (A stack nested in a collapsed split view's column rebuilt
				// the column on every push and pop.) The story is the overlay below
				// the branches.
				NavigationStack(path: $model.cardsPath) {
					ReaderHomeView()
						.navigationDestination(for: ReaderCardsRoute.self) { route in
							switch route {
							case .list:
								ReaderCollectionPane()
							case let .feed(id):
								ArticleListView(collection: model.navigation.item(withID: id) ?? model.selectedCollection)
							}
						}
				}
				.environment(\.readerWindowHorizontalSizeClass, horizontalSizeClass)
				.allowsHitTesting(showsCompactArticle == false)
				.accessibilityHidden(showsCompactArticle)
			} else {
				NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: splitViewColumn) {
					ReaderHomeView()
						// The system's widths (320 and 375) leave an iPad mini in
						// portrait a narrower reading column than an iPhone has.
						.navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 320)
				} content: {
					ReaderCollectionPane()
						.navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 400)
				} detail: {
					if showsCompactArticle {
						ReaderPlaceholderView(collection: model.selectedCollection)
					} else if let article = model.selectedArticle {
						ArticleReaderView(article: article)
					} else {
						ReaderPlaceholderView(collection: model.selectedCollection)
					}
				}
				.navigationSplitViewStyle(.balanced)
				.environment(\.readerWindowHorizontalSizeClass, horizontalSizeClass)
				.allowsHitTesting(showsCompactArticle == false)
				.accessibilityHidden(showsCompactArticle)
			}

			if model.isInitialLibraryLoading == false, showsCompactArticle, let article = model.selectedArticle {
				// NavigationSplitView that launches on `.detail` has no stack to pop, so
				// the system back item and interactive pop do nothing. Own the article
				// on compact without replacing the library list underneath (in Cards,
				// above the whole stack).
				NavigationStack {
					ArticleReaderView(article: article)
				}
				.frame(maxWidth: .infinity, maxHeight: .infinity)
				.background(.background)
			}
		}
		// Everything below the shell navigates with this size class, so a
		// regular window in Cards gets the phone's stack navigation and
		// full-window reader. The shell's own
		// sheets keep the window's size class; sheets presented from inside
		// the library or reader see the navigation one.
		.environment(\.horizontalSizeClass, horizontalSizeClass)
		.onChange(of: ReaderRegularColumnKey(sizeClass: horizontalSizeClass, column: model.preferredCompactColumn), initial: true) { _, key in
			// Reeder has no Home: a regular window always has a list open beside
			// the library (see `columnWithoutHome`).
			let column = ReaderCompactArticlePresentation.columnWithoutHome(
				horizontalSizeClass: key.sizeClass,
				preferredColumn: key.column,
			)
			if column != key.column { model.preferredCompactColumn = column }
		}
		.onChange(of: model.readerTypography.look) { _, look in
			// Only Cards stacks a feed above its folder; elsewhere the feed
			// stays open as the only list.
			// Next and previous follow the cards only in Cards.
			if look != .cards { model.leaveCardsNavigation() }
			model.preferredCompactColumn = ReaderCompactArticlePresentation.columnAfterLookChange(
				window: windowHorizontalSizeClass,
				look: look,
				preferredColumn: model.preferredCompactColumn,
			)
		}
		.sheet(isPresented: $model.isShowingSettings) {
			SettingsView()
		}
		.sheet(item: $model.pendingFeedRequest) { request in
			#if DEBUG
			AddFeedView(
				initialURL: ProcessInfo.processInfo.arguments.contains("-reader-show-add-feed")
					? ""
					: request.url.absoluteString,
			)
			#else
			AddFeedView(initialURL: request.url.absoluteString)
			#endif
		}
		.overlay(alignment: .bottom) {
			VStack(spacing: 8) {
				ReaderStatusOverlay()
				ReaderArticleUndoBanner()
			}
			.padding(.bottom, 8)
		}
		.task(id: model.session?.storageIdentity) {
			model.configurePlatformServices()
			// Ends by sending links saved offline and extracting pending saves.
			await model.prepareOfflineLibrary()
			await model.handleLocalDayChange()
			await model.writeWidgetSnapshotOffMain()
			if let action = ReaderNotificationManager.shared.consumePendingAction() {
				await model.handleNotificationAction(action)
			}
		}
		.task(id: model.session) {
			// Have a reader web view ready for the first story, made once the
			// launch work has had a moment to settle.
			guard let session = model.session else {
				// The spare and any refill on its way belong to the account that just left.
				ReaderWebViewPool.shared.drain()
				return
			}
			try? await Task.sleep(for: .seconds(2))
			guard Task.isCancelled == false else { return }
			ReaderWebViewPool.shared.prewarm(session: session)
		}
		.task(id: model.isSynchronizingOfflineLibrary) {
			guard model.isSynchronizingOfflineLibrary,
				model.preferredCompactColumn == .sidebar || horizontalSizeClass == .regular else { return }
			// Home and the library need server totals as soon as the cache is
			// restored, even if downloading the complete offline library takes
			// much longer. A regular window always shows the library.
			_ = await model.loadNavigation(force: true, reportError: false)
		}
		.onChange(of: scenePhase, initial: true) { _, phase in
			// Keep this handler cheap. Scene-update watchdogs kill a backgrounded
			// app that stays on the main actor for more than a few seconds.
			model.handleScenePhase(phase)
		}
		.onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in
			Task { await model.handleLocalDayChange() }
		}
		.onReceive(NotificationCenter.default.publisher(for: .pigeonReaderNotificationAction)) { notification in
			guard let action = ReaderNotificationManager.shared.consumePendingAction()
				?? notification.object as? ReaderNotificationAction else { return }
			Task { await model.handleNotificationAction(action) }
		}
	}

	private var horizontalSizeClass: UserInterfaceSizeClass? {
		ReaderCompactArticlePresentation.navigationSizeClass(
			window: windowHorizontalSizeClass,
			look: model.readerTypography.look,
		)
	}

	private var splitViewColumn: Binding<NavigationSplitViewColumn> {
		Binding(
			get: {
				ReaderCompactArticlePresentation.splitViewColumn(
					horizontalSizeClass: horizontalSizeClass,
					preferredColumn: model.preferredCompactColumn,
				)
			},
			set: { model.preferredCompactColumn = $0 },
		)
	}
}

#if DEBUG
#Preview("Sample reader") {
	ReaderShellView()
		.environment(PreviewData.makeModel())
}
#endif

private struct ReaderRegularColumnKey: Equatable {
	let sizeClass: UserInterfaceSizeClass?
	let column: NavigationSplitViewColumn
}
