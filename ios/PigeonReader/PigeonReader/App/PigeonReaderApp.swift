import SwiftUI

@main
struct PigeonReaderApp: App {
	@State private var model: ReaderAppModel

	init() {
		#if DEBUG
		if ProcessInfo.processInfo.arguments.contains("-reader-reset-reader-state") {
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.mode.dense-discovery")
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.typography.text-scale")
			UserDefaults.standard.removeObject(forKey: "pigeon.reader.typography.line-height")
			ReaderArticleFilterStore().removeAll()
		}
		if ProcessInfo.processInfo.arguments.contains("-reader-sample-data") {
			let previewModel = PreviewData.makeModel()
			if ProcessInfo.processInfo.arguments.contains("-reader-show-sidebar") {
				previewModel.preferredCompactColumn = .sidebar
			} else if ProcessInfo.processInfo.arguments.contains("-reader-show-article"),
				let firstArticle = previewModel.articles.first {
				previewModel.select(article: firstArticle)
				previewModel.setReaderMode(.feedContent, for: firstArticle.feedKey)
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
		}
	}
}
