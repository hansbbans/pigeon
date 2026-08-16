import SwiftUI

struct ReaderShellView: View {
	@Environment(ReaderAppModel.self) private var model

	var body: some View {
		@Bindable var model = model

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
		.sheet(isPresented: $model.isShowingSettings) {
			SettingsView()
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
			await model.prepareOfflineLibrary()
		}
	}
}

#if DEBUG
#Preview("Sample reader") {
	ReaderShellView()
		.environment(PreviewData.makeModel())
}
#endif
