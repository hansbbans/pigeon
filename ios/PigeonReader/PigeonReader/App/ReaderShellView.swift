import SwiftUI

struct ReaderShellView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.horizontalSizeClass) private var horizontalSizeClass
	@Environment(\.scenePhase) private var scenePhase

	var body: some View {
		@Bindable var model = model

		Group {
			if horizontalSizeClass != .regular, model.preferredCompactColumn == .detail, let article = model.selectedArticle {
				// NavigationSplitView that launches on `.detail` has no stack to pop, so
				// the system back item and interactive pop do nothing. Own the article
				// on compact and return to the split view when the reader asks.
				NavigationStack {
					ArticleReaderView(article: article)
				}
			} else {
				NavigationSplitView(preferredCompactColumn: $model.preferredCompactColumn) {
					ReaderSidebarView()
				} content: {
					ArticleListView(collection: model.selectedCollection)
				} detail: {
					if let article = model.selectedArticle {
						ArticleReaderView(article: article)
					} else {
						ReaderPlaceholderView(collection: model.selectedCollection)
					}
				}
				.navigationSplitViewStyle(.balanced)
			}
		}
		.sheet(isPresented: $model.isShowingSettings) {
			SettingsView()
		}
		.sheet(item: $model.pendingFeedRequest) { request in
			AddFeedView(initialURL: request.url.absoluteString)
		}
		.safeAreaInset(edge: .top) {
			VStack(spacing: 0) {
				if model.isOffline {
					Label("Offline — showing your saved library", systemImage: "wifi.slash")
						.font(.footnote.weight(.medium))
						.foregroundStyle(.secondary)
						.frame(maxWidth: .infinity)
						.padding(.vertical, 7)
						.background(.bar)
						.accessibilityIdentifier("offline-library-banner")
				}
				if let errorMessage = model.errorMessage {
					ReaderErrorBanner(message: errorMessage, dismiss: model.clearError)
				}
			}
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
}

#if DEBUG
#Preview("Sample reader") {
	ReaderShellView()
		.environment(PreviewData.makeModel())
}
#endif
