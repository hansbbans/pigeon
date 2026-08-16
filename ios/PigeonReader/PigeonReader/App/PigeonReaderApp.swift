import SwiftUI

@main
struct PigeonReaderApp: App {
	@State private var model: ReaderAppModel

	init() {
		BackgroundRefreshManager.shared.register()
		_ = ReaderNotificationManager.shared
		#if DEBUG
		if ProcessInfo.processInfo.arguments.contains("-reader-reset-reader-state") {
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.mode.dense-discovery")
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.typography.text-scale")
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.typography.line-height")
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.typography.horizontal-margin")
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.typography.column-width")
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.theme")
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.remote-images")
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.timeline-density")
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.mark-read-behavior")
			UserDefaults.standard.removeObject(forKey: ReaderSmartViewStore.key)
			ReaderArticleFilterStore().removeAll()
		}
		if ProcessInfo.processInfo.arguments.contains("-reader-sample-data") {
			let previewModel = PreviewData.makeModel()
			if ProcessInfo.processInfo.arguments.contains("-reader-show-sidebar") {
				previewModel.preferredCompactColumn = .sidebar
			} else if ProcessInfo.processInfo.arguments.contains("-reader-show-article") {
				// Keep the launch fixture stable while the opened article is marked read.
				previewModel.setArticleFilter(.all, for: .forYou)
				if let firstArticle = previewModel.articles.first {
					previewModel.select(article: firstArticle)
					previewModel.setReaderMode(.feedContent, for: firstArticle.feedKey)
				}
			}
			_model = State(initialValue: previewModel)
			return
		}
		#endif
		_model = State(initialValue: ReaderAppModel())
	}

	var body: some Scene {
		WindowGroup {
			RootView()
				.environment(model)
				.onOpenURL { url in
					Task { await model.handleDeepLink(url) }
				}
		}
	}
}
