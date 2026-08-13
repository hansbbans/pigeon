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
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				Button("Settings", systemImage: "gearshape") {
					model.isShowingSettings = true
				}
				.keyboardShortcut(",", modifiers: .command)
			}
		}
		.sheet(isPresented: $model.isShowingSettings) {
			SettingsView()
		}
		.safeAreaInset(edge: .top) {
			if let errorMessage = model.errorMessage {
				ReaderErrorBanner(message: errorMessage, dismiss: model.clearError)
			}
		}
	}
}

#if DEBUG
#Preview("Sample reader") {
	ReaderShellView()
		.environment(PreviewData.makeModel())
}
#endif
