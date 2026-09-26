import SwiftUI

struct ReaderShellView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.horizontalSizeClass) private var horizontalSizeClass
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
					ReaderSidebarView()
				} content: {
					ReaderCollectionPane()
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
				.allowsHitTesting(showsCompactArticle == false && showsRegularHome == false)
				.accessibilityHidden(showsCompactArticle || showsRegularHome)

				if showsRegularHome {
					// An iPad in portrait can hide the sidebar even when all split
					// columns are requested. Present Home explicitly until a view is
					// chosen, while keeping the library and reader mounted underneath.
					NavigationStack {
						ReaderSidebarView()
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
			await model.prepareOfflineLibrary()
			await model.handleLocalDayChange()
			model.writeWidgetSnapshot()
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
		.task(id: scenePhase) {
			let active = scenePhase == .active
			model.setApplicationActive(active)
			guard active else { return }
			await model.refreshForLifecycle()
		}
		.onChange(of: scenePhase) { _, phase in
			guard phase == .active else { return }
			Task { await model.handleLocalDayChange() }
			model.consumePendingFeedRequest()
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
