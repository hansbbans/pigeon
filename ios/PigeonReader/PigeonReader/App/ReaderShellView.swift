import SwiftUI

struct ReaderShellView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.horizontalSizeClass) private var windowHorizontalSizeClass
	@Environment(\.scenePhase) private var scenePhase

	var body: some View {
		@Bindable var model = model
		let showsCompactArticle = ReaderCompactArticlePresentation.isActive(
			horizontalSizeClass: horizontalSizeClass,
			preferredColumn: model.preferredCompactColumn,
			hasSelectedArticle: model.selectedArticle != nil,
		)
		let showsRegularHome = horizontalSizeClass == .regular && model.preferredCompactColumn == .sidebar

		ZStack {
			if model.isInitialLibraryLoading {
				NavigationStack {
					ProgressView("Loading your library")
						.frame(maxWidth: .infinity, maxHeight: .infinity)
						.navigationTitle("Pigeon")
						.accessibilityIdentifier("library-startup-loading")
				}
			} else {
				NavigationSplitView(preferredCompactColumn: splitViewColumn) {
					ReaderHomeView(placement: horizontalSizeClass == .compact ? .compactRoot : .splitSidebar)
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
				.allowsHitTesting(showsCompactArticle == false && showsRegularHome == false)
				.accessibilityHidden(showsCompactArticle || showsRegularHome)

				if showsRegularHome {
					// An iPad in portrait can hide the sidebar even when all split
					// columns are requested. Present Home explicitly until a view is
					// chosen, while keeping the library and reader mounted underneath.
					NavigationStack {
						ReaderHomeView(placement: .regularHome)
					}
					.frame(maxWidth: .infinity, maxHeight: .infinity)
					.background(.background)
				}

				if showsCompactArticle, let article = model.selectedArticle {
					// NavigationSplitView that launches on `.detail` has no stack to pop, so
					// the system back item and interactive pop do nothing. Own the article
					// on compact without replacing the library list underneath.
					NavigationStack {
						ArticleReaderView(article: article)
					}
					.frame(maxWidth: .infinity, maxHeight: .infinity)
					.background(.background)
				}
			}
		}
		// Everything below the shell navigates with this size class, so a
		// regular window in Cards collapses the split view and gets the
		// phone's back navigation and full-window reader. The shell's own
		// sheets keep the window's size class; sheets presented from inside
		// the library or reader see the navigation one.
		.environment(\.horizontalSizeClass, horizontalSizeClass)
		.onChange(of: model.readerTypography.look) { _, look in
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
		.task(id: model.isSynchronizingOfflineLibrary) {
			guard model.isSynchronizingOfflineLibrary, model.preferredCompactColumn == .sidebar else { return }
			// Home needs server totals as soon as its cache is restored, even if
			// downloading the complete offline library takes much longer.
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
