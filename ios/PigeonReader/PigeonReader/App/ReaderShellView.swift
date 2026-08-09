import SwiftUI

struct ReaderShellView: View {
	@Environment(ReaderAppModel.self) private var model
	@Environment(\.horizontalSizeClass) private var horizontalSizeClass

	var body: some View {
		@Bindable var model = model

		Group {
			if horizontalSizeClass == .regular {
				NavigationSplitView(preferredCompactColumn: $model.preferredCompactColumn) {
					ReaderSidebarView()
				} content: {
					ArticleListView(destination: model.selectedDestination)
				} detail: {
					if let article = model.selectedArticle {
						ArticleReaderView(article: article)
					} else {
						ReaderPlaceholderView(title: model.selectedDestinationTitle)
					}
				}
				.navigationSplitViewStyle(.balanced)
			} else {
				CompactReaderNavigationView()
			}
		}
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

private struct CompactReaderNavigationView: View {
	@Environment(ReaderAppModel.self) private var model
	@State private var path: [CompactReaderRoute] = []
	@State private var didSeedPath = false

	var body: some View {
		NavigationStack(path: $path) {
			ReaderSidebarView { destination in
				path = [.stories(destination)]
			}
			.navigationDestination(for: CompactReaderRoute.self) { route in
				switch route {
				case .stories(let destination):
					ArticleListView(destination: destination) { _ in
						path.append(.article)
					}
				case .article:
					if let article = model.selectedArticle {
						ArticleReaderView(article: article)
					} else {
						ReaderPlaceholderView(title: model.selectedDestinationTitle)
					}
				}
			}
		}
		.task {
			guard didSeedPath == false else {
				return
			}
			didSeedPath = true
			switch model.preferredCompactColumn {
			case .content:
				path = [.stories(model.selectedDestination)]
			case .detail where model.selectedArticle != nil:
				path = [.stories(model.selectedDestination), .article]
			default:
				break
			}
		}
		.onChange(of: model.selectedArticleID) { _, newValue in
			if newValue == nil, path.last == .article {
				path.removeLast()
			}
		}
	}
}

private enum CompactReaderRoute: Hashable {
	case stories(ReaderDestination)
	case article
}

#if DEBUG
#Preview("Sample reader") {
	ReaderShellView()
		.environment(PreviewData.makeModel())
}
#endif
